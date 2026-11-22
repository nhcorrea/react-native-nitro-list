#include "LayoutCore.hpp"

#include <algorithm>
#include <chrono>
#include <cmath>

namespace margelo::nitro::nitrolist {

namespace {

constexpr double kBufferAheadRatio = 1.5;
constexpr double kBufferBehindRatio = 0.5;
constexpr double kStallMinMs = 80.0;
constexpr double kStallMemoryMs = 3000.0;
constexpr double kStallLeadMarginMs = 16.0;
constexpr double kLeadAheadMaxViewports = 2.0;
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
  if (hasDirtyItemBlocks_) materializeAllDirtyBlocksLocked();
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
  const auto blocks = static_cast<size_t>(blockCountFor(count));
  if (blockBase_.size() < blocks) {
    blockBase_.resize(blocks, 0.0);
    blockSum_.resize(blocks, 0.0);
    blockMeasuredSum_.resize(blocks, 0.0);
    blockUnmeasuredCount_.resize(blocks, 0);
    blockUniformType_.resize(blocks, 0);
    blockItemDirty_.resize(blocks, 0);
    blockStatsValid_.resize(blocks, 0);
    blockDirty_.resize(blocks, 0);
  }
  markWideDirtyLocked(dirtyStart);
  if (shrank) {
    if (!blockMixedCounts_.empty()) {
      const int32_t maxBlock = static_cast<int32_t>(blocks);
      for (auto it = blockMixedCounts_.begin(); it != blockMixedCounts_.end();) {
        if (it->first >= maxBlock) it = blockMixedCounts_.erase(it);
        else ++it;
      }
    }
    releaseCapacityLocked();
    pruneFrozenLocked();
    rebuildTypeObservationsLocked();
    applyTypeMeansLocked();
  }
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
  if (hasDirtyItemBlocks_) materializeAllDirtyBlocksLocked();
  if (!std::isfinite(value)) {
    return false;
  }
  const float rounded = roundToOctave(std::max(0.0, value));
  if (!std::isfinite(rounded) || rounded == estimate_) {
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
  if (index < 0 || index >= itemCount_ || !std::isfinite(size) || size < 0.0) {
    return false;
  }
  const float rounded = roundToOctave(size);
  if (!std::isfinite(rounded)) {
    return false;
  }
  if (measured_[index] != 0 && std::abs(sizes_[index] - rounded) <= measurementEpsilon_) {
    return false;
  }
  if (hasDirtyItemBlocks_) ensureBlockMaterializedLocked(index >> kBlockShift);
  const float previousSize = sizes_[index];
  recordMeasurementLocked(index, rounded);
  geometryChanged_ = geometryChanged_ || previousSize != rounded;
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
    const float rounded = std::max(0.0f, roundToOctave(rawSize));
    if (!std::isfinite(rounded)) {
      continue;
    }
    if (measured_[idx] != 0 && std::abs(sizes_[idx] - rounded) <= measurementEpsilon_) {
      continue;
    }
    if (hasDirtyItemBlocks_) ensureBlockMaterializedLocked(idx >> kBlockShift);
    const float previousSize = sizes_[idx];
    recordMeasurementLocked(idx, rounded);
    geometryChanged_ = geometryChanged_ || previousSize != rounded;
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
  if (hasDirtyItemBlocks_) materializeAllDirtyBlocksLocked();
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
  invalidateItemSizesRange(start, itemCount_, clearPriors, keptPairs, keptCount);
}

void LayoutCore::invalidateItemSizesRange(int32_t start, int32_t end, bool clearPriors,
                                          const double* keptPairs, int32_t keptCount) {
  std::lock_guard<std::mutex> guard(mutex_);
  if (hasDirtyItemBlocks_) materializeAllDirtyBlocksLocked();
  start = std::clamp(start, 0, itemCount_);
  end = std::clamp(end, start, itemCount_);
  if (clearPriors) typeStats_.clear();
  std::vector<bool> kept;
  if (!clearPriors && keptPairs != nullptr && keptCount > 0 && start < end) {
    kept.assign(static_cast<size_t>(end - start), false);
    for (int32_t p = 0; p < keptCount; ++p) {
      const double raw = keptPairs[p * 2];
      if (!std::isfinite(raw) || raw < start || raw >= end || raw != std::floor(raw)) continue;
      kept[static_cast<size_t>(raw) - start] = true;
    }
  }
  bool removedObservation = false;
  for (int32_t i = start; i < end; ++i) {
    if (!kept.empty() && kept[i - start] && measured_[i] != 0) continue;
    removedObservation = removedObservation || measured_[i] != 0;
    measured_[i] = 0;
    const float target = estimateForTypeLocked(types_[i]);
    geometryChanged_ = geometryChanged_ || sizes_[i] != target;
    sizes_[i] = target;
    if (columnCount_ == 1 && end < itemCount_) {
      markItemDirtyLocked(i);
    }
  }
  pruneFrozenLocked();
  if (removedObservation || clearPriors) rebuildTypeObservationsLocked();
  if (columnCount_ > 1 || end >= itemCount_) {
    markWideDirtyLocked(start);
  }
  hasRangeWindow_ = false;
}

bool LayoutCore::remapItemSizes(const double* pairs, int32_t pairCount) {
  std::lock_guard<std::mutex> guard(mutex_);
  if (hasDirtyItemBlocks_) materializeAllDirtyBlocksLocked();
  if (pairs == nullptr || pairCount <= 0 || itemCount_ == 0) {
    return false;
  }
  const auto sourceLimit = static_cast<int32_t>(sizes_.size());
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
      const int32_t block = i >> kBlockShift;
      if (block < static_cast<int32_t>(blockStatsValid_.size())) {
        blockStatsValid_[block] = 0;
      }
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
  truncateCapacity(blockMeasuredSum_, blocks);
  truncateCapacity(blockUnmeasuredCount_, blocks);
  truncateCapacity(blockUniformType_, blocks);
  truncateCapacity(blockItemDirty_, blocks);
  truncateCapacity(blockStatsValid_, blocks);
  truncateCapacity(blockDirty_, blocks);
  if (blockMixedCounts_.empty()) {
    std::unordered_map<int32_t, std::vector<std::pair<uint16_t, uint8_t>>>().swap(blockMixedCounts_);
  }
  std::vector<float>().swap(remapSizes_);
  std::vector<uint8_t>().swap(remapMeasured_);
}

void LayoutCore::resetAll() {
  std::lock_guard<std::mutex> guard(mutex_);
  std::unordered_map<int32_t, float>().swap(frozen_);
  std::vector<float>().swap(remapSizes_);
  std::vector<uint8_t>().swap(remapMeasured_);
  std::vector<float>().swap(sizes_);
  std::vector<double>().swap(offsets_);
  std::vector<uint8_t>().swap(measured_);
  std::vector<uint16_t>().swap(types_);
  std::vector<uint16_t>().swap(spans_);
  std::vector<int32_t>().swap(rowStart_);
  std::vector<TypeStats>().swap(typeStats_);
  std::vector<uint8_t>().swap(pendingTypeMeans_);
  hasDirtyItemBlocks_ = false;
  columnCount_ = 1;
  itemCount_ = 0;
  estimate_ = 0.0f;
  totalSize_ = 0.0;
  estimatesFrozen_ = false;
  minDirtyIndex_ = INT32_MAX;
  wideDirtyIndex_ = INT32_MAX;
  minRebaseBlock_ = INT32_MAX;
  std::vector<double>().swap(blockBase_);
  std::vector<double>().swap(blockSum_);
  std::vector<double>().swap(blockMeasuredSum_);
  std::vector<uint8_t>().swap(blockUnmeasuredCount_);
  std::vector<int32_t>().swap(blockUniformType_);
  std::vector<uint8_t>().swap(blockItemDirty_);
  std::vector<uint8_t>().swap(blockStatsValid_);
  std::unordered_map<int32_t, std::vector<std::pair<uint16_t, uint8_t>>>().swap(blockMixedCounts_);
  std::vector<uint8_t>().swap(blockDirty_);
  std::vector<int32_t>().swap(dirtyBlocks_);
  layoutVersion_ = 0;
  geometryChanged_ = false;
  hasRangeWindow_ = false;
  rangeWindowMin_ = 0.0;
  rangeWindowMax_ = 0.0;
  rangeWindowViewport_ = -1.0;
  rangeWindowDraw_ = -1.0;
  rangeWindowAhead_ = -1.0;
  stallMs_ = 0.0;
  stallAtMs_ = -1.0;
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
  const size_t frozenBuckets = frozen_.bucket_count() > 1 ? frozen_.bucket_count() : 0;
  const size_t mixedBuckets = blockMixedCounts_.bucket_count() > 1 ? blockMixedCounts_.bucket_count() : 0;
  size_t mixedBytes = mixedBuckets * sizeof(void*) +
                      blockMixedCounts_.size() *
                          (sizeof(std::pair<const int32_t, std::vector<std::pair<uint16_t, uint8_t>>>) +
                           2 * sizeof(void*));
  for (const auto& entry : blockMixedCounts_) {
    mixedBytes += entry.second.capacity() * sizeof(std::pair<uint16_t, uint8_t>);
  }
  return sizes_.capacity() * sizeof(float) + offsets_.capacity() * sizeof(double) +
         measured_.capacity() * sizeof(uint8_t) + types_.capacity() * sizeof(uint16_t) +
         spans_.capacity() * sizeof(uint16_t) + rowStart_.capacity() * sizeof(int32_t) +
         typeStats_.capacity() * sizeof(TypeStats) + pendingTypeMeans_.capacity() * sizeof(uint8_t) +
         remapSizes_.capacity() * sizeof(float) +
         remapMeasured_.capacity() * sizeof(uint8_t) + blockBase_.capacity() * sizeof(double) +
         blockSum_.capacity() * sizeof(double) + blockMeasuredSum_.capacity() * sizeof(double) +
         blockUnmeasuredCount_.capacity() * sizeof(uint8_t) +
         blockUniformType_.capacity() * sizeof(int32_t) +
         blockItemDirty_.capacity() * sizeof(uint8_t) +
         blockStatsValid_.capacity() * sizeof(uint8_t) + mixedBytes +
         blockDirty_.capacity() * sizeof(uint8_t) +
         dirtyBlocks_.capacity() * sizeof(int32_t) +
         frozen_.size() * (sizeof(std::pair<const int32_t, float>) + 2 * sizeof(void*)) +
         frozenBuckets * sizeof(void*);
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
  if (hasDirtyItemBlocks_) materializeAllDirtyBlocksLocked();
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
    if (types_[i] != type) {
      if (measured_[i] != 0) measuredTypeChanged = true;
      const int32_t block = i >> kBlockShift;
      if (block < static_cast<int32_t>(blockStatsValid_.size())) {
        blockStatsValid_[block] = 0;
      }
      types_[i] = type;
    }
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
  if (hasDirtyItemBlocks_) materializeAllDirtyBlocksLocked();
  if (!typeAverages_ || pairs == nullptr || pairCount <= 0) {
    return false;
  }
  bool anySeeded = false;
  for (int32_t p = 0; p < pairCount; p++) {
    const double rawType = pairs[2 * p], rawMean = pairs[2 * p + 1] * scale;
    if (!std::isfinite(rawType) || rawType != std::floor(rawType) || rawType <= 0 ||
        rawType >= kMaxTypeStats || !std::isfinite(rawMean)) {
      continue;
    }
    const auto type = static_cast<int32_t>(rawType);
    const float mean = roundToOctave(rawMean);
    if (!std::isfinite(mean) || !(mean > 0.0f)) {
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
  if (hasDirtyItemBlocks_) materializeAllDirtyBlocksLocked();
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
  return currentSizeLocked(index);
}

void LayoutCore::getColumnSpan(int32_t index, int32_t& outCol, int32_t& outSpan) {
  std::lock_guard<std::mutex> guard(mutex_);
  if (columnCount_ <= 1 || index < 0 || index >= itemCount_) {
    outCol = 0;
    outSpan = 1;
    return;
  }
  ensureClean();
  outSpan = spanAtLocked(index);
  const int32_t rs = index < static_cast<int32_t>(rowStart_.size()) ? rowStart_[index] : index;
  int32_t col = 0;
  for (int32_t i = rs; i < index; ++i) {
    col += spanAtLocked(i);
  }
  outCol = col;
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
    const double off = offsetAtLocked(i);
    *cursor++ = off;
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
    const double off = offsetAtLocked(i);
    *cursor++ = off * outputScale;
    *cursor++ = static_cast<double>(sizes_[i]) * outputScale;
  }
  return count;
}

LayoutCore::SlabResult LayoutCore::fillSnapshotSlab(
    double* bodyOut, int32_t bodyCapacityDoubles, double scrollOffset, double viewportHeight,
    double drawDistance, double outputScale, bool canSkipIfMatching, int32_t matchStart,
    int32_t matchEnd, int32_t matchVersion, std::vector<double>* overflowOut,
    int32_t overflowHeaderDoubles) {
  std::lock_guard<std::mutex> guard(mutex_);
  const EngagedRange range = computeEngagedRangeLocked(scrollOffset, viewportHeight, drawDistance);
  const int32_t count = range.end >= range.start ? range.end - range.start + 1 : 0;
  const int32_t bodyDoubles = count * 2;
  const bool insufficient = bodyOut == nullptr || bodyCapacityDoubles < bodyDoubles;
  if (insufficient) {
    if (overflowOut != nullptr) {
      overflowOut->resize(static_cast<size_t>(overflowHeaderDoubles + bodyDoubles));
      double* cursor = overflowOut->data() + overflowHeaderDoubles;
      for (int32_t i = range.start; i < range.start + count; i++) {
        const double off = offsetAtLocked(i);
        *cursor++ = off * outputScale;
        *cursor++ = static_cast<double>(sizes_[i]) * outputScale;
      }
    }
    return SlabResult{range, totalSize_ * outputScale, count, true};
  }
  const bool skipBody = canSkipIfMatching && range.start == matchStart && range.end == matchEnd &&
                        range.version == matchVersion;
  if (!skipBody && count > 0) {
    double* cursor = bodyOut;
    for (int32_t i = range.start; i < range.start + count; i++) {
      const double off = offsetAtLocked(i);
      *cursor++ = off * outputScale;
      *cursor++ = static_cast<double>(sizes_[i]) * outputScale;
    }
  }
  return SlabResult{range, totalSize_ * outputScale, count, false};
}

LayoutCore::EngagedRange LayoutCore::computeEngagedRangeLocked(double scrollOffset,
                                                               double viewportHeight,
                                                               double drawDistance) {
  const double now = directionalBuffers_ ? (clock_ != nullptr ? clock_() : defaultClockMs()) : 0.0;
  if (directionalBuffers_ && scrollOffset != lastSampleOffset_) {
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
        if (dt >= kStallMinMs) {
          stallMs_ = stallAtMs_ >= 0.0 && now - stallAtMs_ <= kStallMemoryMs ? std::max(stallMs_, dt) : dt;
          stallAtMs_ = now;
        }
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
  const double leadStep = std::max(1.0, drawDistance * 0.5);
  const bool stalling = regime != 0 && stallAtMs_ >= 0.0 && now - stallAtMs_ <= kStallMemoryMs;
  const double lead = !stalling ? 0.0
                                : std::floor(std::min(std::abs(velocity_) * (stallMs_ + kStallLeadMarginMs) / 1000.0,
                                                      viewportHeight * kLeadAheadMaxViewports) /
                                             leadStep) *
                                      leadStep;
  const double ahead = std::max(drawDistance * kBufferAheadRatio, lead);
  double topBuffer = regime == 0    ? drawDistance
                     : regime > 0   ? drawDistance * kBufferBehindRatio
                                    : ahead;
  double bottomBuffer = regime == 0  ? drawDistance
                        : regime > 0 ? ahead
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
      ahead == rangeWindowAhead_ && regime == cachedRegime_ && scrollOffset > rangeWindowMin_ &&
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
    const double prevOff = offsetAtLocked(start - 1);
    lower = std::max(lower, prevOff + sizes_[start - 1] + topBuffer);
  }
  const double startOff = offsetAtLocked(start);
  double upper = startOff + sizes_[start] + topBuffer;
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
  rangeWindowAhead_ = ahead;
  hasRangeWindow_ = !atEdge && upper > lower;
  return EngagedRange{start, end, layoutVersion_};
}

void LayoutCore::setColumnCount(int32_t columns) {
  std::lock_guard<std::mutex> guard(mutex_);
  if (hasDirtyItemBlocks_) materializeAllDirtyBlocksLocked();
  const int32_t clamped = std::max(1, columns);
  if (clamped == columnCount_) {
    return;
  }
  columnCount_ = clamped;
  typeStats_.clear();
  frozen_.clear();
  std::fill(blockStatsValid_.begin(), blockStatsValid_.end(), 0);
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
#ifdef NITROLIST_LAYOUT_TEST_COUNTERS
  ++blockRebuilds_;
#endif
  const int32_t first = block << kBlockShift;
  const int32_t last = std::min(itemCount_, first + kBlockSize);
  const bool applyPending =
      block < static_cast<int32_t>(blockItemDirty_.size()) && blockItemDirty_[block] != 0;
  double local = 0.0;
  double measuredSum = 0.0;
  uint8_t unmeasuredCount = 0;
  int32_t uniformType = -2;
  bool statsSafe = true;
  for (int32_t i = first; i < last; i++) {
    if (applyPending && measured_[i] == 0) {
      const float next = estimateForTypeLocked(types_[i]);
      if (sizes_[i] != next) {
        sizes_[i] = next;
        anyChanged = true;
      }
    }
    if (offsets_[i] != local) {
      offsets_[i] = local;
      anyChanged = true;
    }
    const float sz = sizes_[i];
    if (sz > 1e10f) statsSafe = false;
    local += sz;
    if (measured_[i] != 0) {
      measuredSum += sz;
    } else {
      ++unmeasuredCount;
      const int32_t t = static_cast<int32_t>(types_[i]);
      if (uniformType == -2) uniformType = t;
      else if (uniformType != t) uniformType = -1;
    }
  }
  blockSum_[block] = local;
  if (block < static_cast<int32_t>(blockMeasuredSum_.size())) {
    blockMeasuredSum_[block] = measuredSum;
    blockUnmeasuredCount_[block] = unmeasuredCount;
    blockUniformType_[block] = uniformType == -2 ? 0 : uniformType;
    blockItemDirty_[block] = 0;
    blockStatsValid_[block] = statsSafe ? 1 : 0;
    if (uniformType == -1 && statsSafe) {
      auto& counts = blockMixedCounts_[block];
      counts.clear();
      for (int32_t i = first; i < last; ++i) {
        if (measured_[i] != 0) continue;
        const uint16_t t = types_[i];
        bool found = false;
        for (auto& kv : counts) {
          if (kv.first == t) {
            ++kv.second;
            found = true;
            break;
          }
        }
        if (!found) counts.emplace_back(t, static_cast<uint8_t>(1));
      }
    } else if (!blockMixedCounts_.empty()) {
      blockMixedCounts_.erase(block);
    }
  }
}

void LayoutCore::ensureBlockMaterializedLocked(int32_t block) {
  if (columnCount_ > 1 || block < 0 ||
      block >= static_cast<int32_t>(blockItemDirty_.size()) || blockItemDirty_[block] == 0) {
    return;
  }
  materializeBlockLocked(block);
}

void LayoutCore::materializeBlockLocked(int32_t block, bool recordGeometryChange) {
#ifdef NITROLIST_LAYOUT_TEST_COUNTERS
  ++blockMaterializations_;
#endif
  const int32_t first = block << kBlockShift;
  const int32_t last = std::min(itemCount_, first + kBlockSize);
  double local = 0.0;
  for (int32_t i = first; i < last; ++i) {
    if (measured_[i] == 0) {
      const float next = estimateForTypeLocked(types_[i]);
      if (recordGeometryChange && sizes_[i] != next) {
        geometryChanged_ = true;
      }
      sizes_[i] = next;
    }
    offsets_[i] = local;
    local += sizes_[i];
  }
  blockItemDirty_[block] = 0;
}

void LayoutCore::materializeAllDirtyBlocksLocked() {
  if (!hasDirtyItemBlocks_) return;
  const int32_t blocks = std::min(blockCountFor(itemCount_), static_cast<int32_t>(blockItemDirty_.size()));
  const int32_t wideFrom =
      wideDirtyIndex_ != INT32_MAX
          ? (std::min(wideDirtyIndex_, std::max(0, itemCount_ - 1)) >> kBlockShift)
          : INT32_MAX;
  for (int32_t b = 0; b < blocks; ++b) {
    if (blockItemDirty_[b] != 0) {
      const bool dirty = b >= wideFrom || (b < static_cast<int32_t>(blockDirty_.size()) && blockDirty_[b] != 0);
      materializeBlockLocked(b, dirty);
    }
  }
  hasDirtyItemBlocks_ = false;
}

void LayoutCore::ensureCleanBlocksLocked(bool& anyChanged) {
  const int32_t blocks = blockCountFor(itemCount_);
  int32_t rebase = minRebaseBlock_;
  minRebaseBlock_ = INT32_MAX;
  int32_t wideFrom = INT32_MAX;
  if (wideDirtyIndex_ != INT32_MAX) {
    wideFrom = std::min(wideDirtyIndex_, std::max(0, itemCount_ - 1)) >> kBlockShift;
    for (int32_t block = wideFrom; block < blocks; block++) rebuildBlockLocked(block, anyChanged);
    rebase = std::min(rebase, wideFrom);
    if (wideFrom == 0) hasDirtyItemBlocks_ = false;
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

double LayoutCore::offsetAtLocked(int32_t index) {
  if (columnCount_ > 1) return offsets_[index];
  const int32_t block = index >> kBlockShift;
  if (hasDirtyItemBlocks_) ensureBlockMaterializedLocked(block);
  return blockBase_[block] + offsets_[index];
}

int32_t LayoutCore::lastIndexAtOrBelowLocked(double value) {
  if (itemCount_ <= 0) return 0;
  if (columnCount_ > 1) {
    const auto it = std::upper_bound(offsets_.begin() + 1, offsets_.begin() + itemCount_, value);
    return static_cast<int32_t>(it - offsets_.begin()) - 1;
  }
  const int32_t blocks = blockCountFor(itemCount_);
  const auto blockIt = std::upper_bound(blockBase_.begin() + 1, blockBase_.begin() + blocks, value);
  const int32_t block = static_cast<int32_t>(blockIt - blockBase_.begin()) - 1;
  if (hasDirtyItemBlocks_) ensureBlockMaterializedLocked(block);
  const int32_t first = block << kBlockShift;
  const int32_t last = std::min(itemCount_, first + kBlockSize);
  const auto it = std::upper_bound(offsets_.begin() + first + 1, offsets_.begin() + last, value - blockBase_[block]);
  return static_cast<int32_t>(it - offsets_.begin()) - 1;
}

int32_t LayoutCore::lastIndexBelowLocked(double value, int32_t from) {
  if (columnCount_ > 1) {
    const auto it = std::lower_bound(offsets_.begin() + from, offsets_.begin() + itemCount_, value);
    return static_cast<int32_t>(it - offsets_.begin()) - 1;
  }
  const int32_t blocks = blockCountFor(itemCount_);
  const int32_t fromBlock = from >> kBlockShift;
  const auto blockIt = std::lower_bound(blockBase_.begin() + fromBlock, blockBase_.begin() + blocks, value);
  int32_t block = static_cast<int32_t>(blockIt - blockBase_.begin()) - 1;
  if (block < fromBlock) return from - 1;
  if (hasDirtyItemBlocks_) ensureBlockMaterializedLocked(block);
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
    if (hasDirtyItemBlocks_) materializeAllDirtyBlocksLocked();
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
  minRebaseBlock_ = INT32_MAX;
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
  if (lazyTypeMeans_ && columnCount_ == 1) {
    // Bring already-queued dirty blocks up to pre-drift estimates so rebuildBlockLocked
    // detects exact geometry diffs when the new mean is applied.
    if (hasDirtyItemBlocks_) {
      const int32_t wideFromPre =
          wideDirtyIndex_ != INT32_MAX
              ? (std::min(wideDirtyIndex_, std::max(0, itemCount_ - 1)) >> kBlockShift)
              : INT32_MAX;
      for (const int32_t b : dirtyBlocks_) {
        if (b >= 0 && b < static_cast<int32_t>(blockItemDirty_.size()) && blockItemDirty_[b] != 0) {
          materializeBlockLocked(b, true);
        }
      }
      if (wideFromPre < static_cast<int32_t>(blockItemDirty_.size())) {
        const int32_t blocksPre = blockCountFor(itemCount_);
        for (int32_t b = wideFromPre; b < blocksPre; ++b) {
          if (blockItemDirty_[b] != 0) materializeBlockLocked(b, true);
        }
      }
    }
    pendingTypeMeans_.assign(typeStats_.size(), 0);
    bool anyEstChanged = false;
    for (size_t type = 0; type < typeStats_.size(); ++type) {
      auto& stats = typeStats_[type];
      if (stats.num > 0 && std::abs(stats.mean - stats.appliedMean) > typeMeanSweepBar(stats.appliedMean)) {
        const float oldEst = estimateForTypeLocked(static_cast<uint16_t>(type));
        stats.appliedMean = stats.mean;
        const float newEst = estimateForTypeLocked(static_cast<uint16_t>(type));
        if (newEst != oldEst) {
          pendingTypeMeans_[type] = 1;
          anyEstChanged = true;
        }
      }
    }
    if (!anyEstChanged || itemCount_ == 0) {
      return false;
    }
    const int32_t blocks = blockCountFor(itemCount_);
    const int32_t wideFrom =
        wideDirtyIndex_ != INT32_MAX
            ? (std::min(wideDirtyIndex_, std::max(0, itemCount_ - 1)) >> kBlockShift)
            : INT32_MAX;
    bool anyUpdated = false;
    for (int32_t b = 0; b < blocks; ++b) {
#ifdef NITROLIST_LAYOUT_TEST_COUNTERS
      ++typeMeanVisits_;
#endif
      if (b >= wideFrom) {
        blockItemDirty_[b] = 1;
        hasDirtyItemBlocks_ = true;
        anyUpdated = true;
        continue;
      }
      if (blockDirty_[b] != 0 || blockStatsValid_[b] == 0) {
        blockItemDirty_[b] = 1;
        hasDirtyItemBlocks_ = true;
        markItemDirtyLocked(b << kBlockShift);
        anyUpdated = true;
        continue;
      }
      if (blockUnmeasuredCount_[b] == 0) {
        continue;
      }
      if (blockUniformType_[b] >= 0) {
        const auto t = static_cast<uint16_t>(blockUniformType_[b]);
        if (t >= pendingTypeMeans_.size() || pendingTypeMeans_[t] == 0) continue;
        blockSum_[b] = blockMeasuredSum_[b] +
                       static_cast<double>(blockUnmeasuredCount_[b]) *
                           static_cast<double>(estimateForTypeLocked(t));
        blockItemDirty_[b] = 1;
        hasDirtyItemBlocks_ = true;
        geometryChanged_ = true;
        anyUpdated = true;
        minRebaseBlock_ = std::min(minRebaseBlock_, b);
        minDirtyIndex_ = std::min(minDirtyIndex_, b << kBlockShift);
      } else {
        const auto it = blockMixedCounts_.find(b);
        if (it == blockMixedCounts_.end()) {
          blockItemDirty_[b] = 1;
          hasDirtyItemBlocks_ = true;
          markItemDirtyLocked(b << kBlockShift);
          anyUpdated = true;
          continue;
        }
        bool affected = false;
        for (const auto& kv : it->second) {
          if (kv.first < pendingTypeMeans_.size() && pendingTypeMeans_[kv.first] != 0) {
            affected = true;
            break;
          }
        }
        if (!affected) continue;
        double nextSum = blockMeasuredSum_[b];
        for (const auto& kv : it->second) {
          nextSum += static_cast<double>(kv.second) *
                     static_cast<double>(estimateForTypeLocked(kv.first));
        }
        blockSum_[b] = nextSum;
        blockItemDirty_[b] = 1;
        hasDirtyItemBlocks_ = true;
        geometryChanged_ = true;
        anyUpdated = true;
        minRebaseBlock_ = std::min(minRebaseBlock_, b);
        minDirtyIndex_ = std::min(minDirtyIndex_, b << kBlockShift);
      }
    }
    if (anyUpdated) {
      hasRangeWindow_ = false;
    }
    return anyUpdated;
  }
  bool anyChanged = false;
  for (int32_t i = 0; i < itemCount_; i++) {
#ifdef NITROLIST_LAYOUT_TEST_COUNTERS
    ++typeMeanVisits_;
#endif
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

void LayoutCore::setLazyTypeMeans(bool enabled) {
  std::lock_guard<std::mutex> guard(mutex_);
  if (lazyTypeMeans_ == enabled) return;
  if (hasDirtyItemBlocks_) materializeAllDirtyBlocksLocked();
  lazyTypeMeans_ = enabled;
  if (!enabled) std::vector<uint8_t>().swap(pendingTypeMeans_);
}

float LayoutCore::currentSizeLocked(int32_t index) const {
  if (measured_[index] != 0) return sizes_[index];
  if (columnCount_ == 1 && hasDirtyItemBlocks_) {
    const int32_t block = index >> kBlockShift;
    if (block < static_cast<int32_t>(blockItemDirty_.size()) && blockItemDirty_[block] != 0) {
      return estimateForTypeLocked(types_[index]);
    }
  }
  return sizes_[index];
}

float LayoutCore::estimateForTypeLocked(uint16_t type) const {
  if (typeAverages_ && type < typeStats_.size() &&
      (typeStats_[type].num > 0 || typeStats_[type].seeded)) {
    const double published = typeStats_[type].appliedMean;
    return published > 0.0 ? roundToOctave(published) : estimate_;
  }
  return estimate_;
}

}
