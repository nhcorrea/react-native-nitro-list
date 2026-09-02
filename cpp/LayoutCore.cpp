#include "LayoutCore.hpp"

#include <algorithm>
#include <chrono>
#include <cmath>

namespace margelo::nitro::nitrolist {

namespace {

constexpr double kBufferAheadRatio = 1.5;
constexpr double kBufferBehindRatio = 0.5;
constexpr double kDirectionalMinVelocity = 300.0;
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
  itemCount_ = count;
  minDirtyIndex_ = 0;
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
}

void LayoutCore::setClockForTesting(ClockFn clock) {
  std::lock_guard<std::mutex> guard(mutex_);
  clock_ = clock;
  velocity_ = 0.0;
  lastSampleTimeMs_ = -1.0;
  regime_ = 0;
  pendingRegime_ = 0;
  pendingRegimeCount_ = 0;
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
      sizes_[i] = rounded;
      anyChanged = true;
      minDirtyIndex_ = std::min(minDirtyIndex_, i);
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
  updateTypeMeanLocked(index, measured_[index] != 0, sizes_[index], rounded);
  sizes_[index] = rounded;
  measured_[index] = 1;
  minDirtyIndex_ = std::min(minDirtyIndex_, index);
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
    before = offsets_[anchorIndex];
  }
  const bool anyChanged = applyItemSizesLocked(pairs, pairCount, scale);
  if (!anchorValid || !anyChanged) {
    return 0.0;
  }
  ensureClean();
  return offsets_[anchorIndex] - before;
}

bool LayoutCore::applyItemSizesLocked(const double* pairs, int32_t pairCount, double scale) {
  if (pairs == nullptr || pairCount <= 0) {
    return false;
  }
  bool anyChanged = false;
  for (int32_t i = 0; i < pairCount; i++) {
    const auto idx = static_cast<int32_t>(pairs[i * 2]);
    if (idx < 0 || idx >= itemCount_) {
      continue;
    }
    const float rounded = std::max(0.0f, roundToOctave(pairs[i * 2 + 1] * scale));
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
  std::vector<float> newSizes(itemCount_);
  std::vector<uint8_t> newMeasured(itemCount_, 0);
  for (int32_t i = 0; i < itemCount_; i++) {
    newSizes[i] = estimateForTypeLocked(types_[i]);
  }
  const auto sourceLimit = static_cast<int32_t>(sizes_.size());
  for (int32_t p = 0; p < pairCount; p++) {
    const double oldRaw = pairs[p * 2];
    const double newRaw = pairs[p * 2 + 1];
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
  layoutVersion_ = 0;
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
}

size_t LayoutCore::getMemoryFootprint() {
  std::lock_guard<std::mutex> guard(mutex_);
  return sizes_.capacity() * sizeof(float) + offsets_.capacity() * sizeof(double) +
         measured_.capacity() * sizeof(uint8_t) + types_.capacity() * sizeof(uint16_t) +
         typeStats_.capacity() * sizeof(TypeStats);
}

bool LayoutCore::setItemTypes(const uint16_t* types, int32_t count) {
  std::lock_guard<std::mutex> guard(mutex_);
  return assignTypesLocked(0, types, count);
}

bool LayoutCore::setItemTypesRange(int32_t start, const uint16_t* types, int32_t count) {
  std::lock_guard<std::mutex> guard(mutex_);
  if (start < 0 || start >= itemCount_) {
    return true;
  }
  return assignTypesLocked(start, types, std::min(count, itemCount_ - start));
}

bool LayoutCore::assignTypesLocked(int32_t start, const uint16_t* types, int32_t count) {
  if (static_cast<int32_t>(types_.size()) < itemCount_) {
    types_.resize(itemCount_, 0);
  }
  const int32_t end = start == 0 ? itemCount_ : std::min(itemCount_, start + std::max(0, count));
  bool allTracked = true;
  for (int32_t i = start; i < end; i++) {
    const int32_t k = i - start;
    const uint16_t type = (types != nullptr && k < count) ? types[k] : 0;
    if (type >= kMaxTypeStats) {
      allTracked = false;
    }
    types_[i] = type;
  }
  for (int32_t i = start; i < end; i++) {
    if (measured_[i] != 0) {
      continue;
    }
    const float target = estimateForTypeLocked(types_[i]);
    if (sizes_[i] != target) {
      sizes_[i] = target;
      minDirtyIndex_ = std::min(minDirtyIndex_, i);
    }
  }
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
  return offsets_[index];
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
    *cursor++ = offsets_[i] * outputScale;
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
    if (lastSampleTimeMs_ >= 0.0) {
      const double dt = now - lastSampleTimeMs_;
      if (dt > kVelocityStaleMs) {
        velocity_ = 0.0;
        sampled = true;
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
      }
      if (candidate == regime_) {
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
  const double topBuffer = regime == 0    ? drawDistance
                           : regime > 0   ? drawDistance * kBufferBehindRatio
                                          : drawDistance * kBufferAheadRatio;
  const double bottomBuffer = regime == 0  ? drawDistance
                              : regime > 0 ? drawDistance * kBufferAheadRatio
                                           : drawDistance * kBufferBehindRatio;
  if (hasRangeWindow_ && minDirtyIndex_ == INT32_MAX && cachedVersion_ == layoutVersion_ &&
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
  const auto beginIt = offsets_.begin() + 1;
  const auto endIt = offsets_.begin() + itemCount_;
  const auto startIt = std::upper_bound(beginIt, endIt, top);
  auto start = static_cast<int32_t>(startIt - offsets_.begin()) - 1;
  const auto endSearchIt = std::lower_bound(offsets_.begin() + start, endIt, bottom);
  int32_t end = static_cast<int32_t>(endSearchIt - offsets_.begin()) - 1;
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
  double lower = offsets_[end] - viewportHeight - bottomBuffer;
  if (start > 0) {
    lower = std::max(lower, offsets_[start - 1] + sizes_[start - 1] + topBuffer);
  }
  double upper = offsets_[start] + sizes_[start] + topBuffer;
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

void LayoutCore::setColumnCount(int32_t columns) {
  std::lock_guard<std::mutex> guard(mutex_);
  const int32_t clamped = std::max(1, columns);
  if (clamped == columnCount_) {
    return;
  }
  columnCount_ = clamped;
  typeStats_.clear();
  for (int32_t i = 0; i < itemCount_; i++) {
    measured_[i] = 0;
    sizes_[i] = estimate_;
  }
  minDirtyIndex_ = 0;
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
      minDirtyIndex_ = std::min(minDirtyIndex_, i);
    }
  }
  if (anyChanged) {
    hasRangeWindow_ = false;
  }
  return anyChanged;
}

int32_t LayoutCore::spanAtLocked(int32_t index) const {
  if (index >= static_cast<int32_t>(spans_.size())) {
    return 1;
  }
  const int32_t span = spans_[index] < 1 ? 1 : spans_[index];
  return std::min(span, columnCount_);
}

void LayoutCore::ensureClean() {
  if (minDirtyIndex_ == INT32_MAX) {
    return;
  }
  bool anyChanged = false;
  if (columnCount_ <= 1) {
    double off =
        minDirtyIndex_ == 0 ? 0.0 : offsets_[minDirtyIndex_ - 1] + sizes_[minDirtyIndex_ - 1];
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
  if (anyChanged) {
    layoutVersion_++;
  }
}

float LayoutCore::roundToOctave(double value) {
  return static_cast<float>(std::round(value * 8.0) / 8.0);
}

void LayoutCore::updateTypeMeanLocked(int32_t index, bool wasMeasured, float prevSize,
                                      float newSize) {
  if (!typeAverages_ || newSize <= 0.0f) {
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
  if (wasMeasured) {
    if (stats.num > 0) {
      stats.mean += (static_cast<double>(newSize) - static_cast<double>(prevSize)) /
                    static_cast<double>(stats.num);
    }
  } else {
    stats.mean = (stats.mean * static_cast<double>(stats.num) + static_cast<double>(newSize)) /
                 static_cast<double>(stats.num + 1);
    stats.num++;
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

}
