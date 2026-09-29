#include "HybridNitroListEngine.hpp"

#include <algorithm>
#include <cmath>
#include <cstring>

namespace margelo::nitro::nitrolist {

namespace {

int32_t toIndex(double value) {
  if (!std::isfinite(value)) {
    return 0;
  }
  return static_cast<int32_t>(std::clamp(value, -2147483648.0, 2147483647.0));
}

const double* doublesOf(const std::shared_ptr<ArrayBuffer>& buffer, int32_t& countOut) {
  if (buffer == nullptr) {
    countOut = 0;
    return nullptr;
  }
  countOut = static_cast<int32_t>(buffer->size() / sizeof(double));
  return reinterpret_cast<const double*>(buffer->data());
}

const uint16_t* shortsOf(const std::shared_ptr<ArrayBuffer>& buffer, int32_t& countOut) {
  if (buffer == nullptr) {
    countOut = 0;
    return nullptr;
  }
  countOut = static_cast<int32_t>(buffer->size() / sizeof(uint16_t));
  return reinterpret_cast<const uint16_t*>(buffer->data());
}

}

HybridNitroListEngine::HybridNitroListEngine() : HybridObject(TAG) {
  core_.setDirectionalBuffers(true);
  core_.setTypeAverages(true);
}

double HybridNitroListEngine::mainViewportLocked() const {
  return horizontal_ ? viewportWidth_ : viewportHeight_;
}

void HybridNitroListEngine::maybeEmitRange() {
  std::optional<RangeCallback> callback;
  int32_t start = 0;
  int32_t end = -1;
  int32_t version = 0;
  double offset = 0.0;
  {
    std::lock_guard<std::mutex> guard(stateMutex_);
    if (!onRangeChange_.has_value()) {
      return;
    }
    const LayoutCore::EngagedRange range =
        core_.getEngagedRange(scrollOffset_, mainViewportLocked(), drawDistance_);
    if (range.start == lastStart_ && range.end == lastEnd_ && range.version == lastVersion_) {
      return;
    }
    lastStart_ = range.start;
    lastEnd_ = range.end;
    lastVersion_ = range.version;
    start = range.start;
    end = range.end;
    version = range.version;
    offset = scrollOffset_;
    callback = onRangeChange_;
    ++sequence_;
  }
  (*callback)(static_cast<double>(start), static_cast<double>(end), static_cast<double>(version),
              offset);
}

std::optional<HybridNitroListEngine::RangeCallback> HybridNitroListEngine::getOnRangeChange() {
  std::lock_guard<std::mutex> guard(stateMutex_);
  return onRangeChange_;
}

void HybridNitroListEngine::setOnRangeChange(const std::optional<RangeCallback>& onRangeChange) {
  {
    std::lock_guard<std::mutex> guard(stateMutex_);
    onRangeChange_ = onRangeChange;
    lastStart_ = -1;
    lastEnd_ = -2;
    lastVersion_ = -1;
  }
  maybeEmitRange();
}

void HybridNitroListEngine::configure(double itemCount, double estimatedItemSize,
                                      double drawDistance, bool horizontal, double numColumns,
                                      double measurementEpsilon) {
  {
    std::lock_guard<std::mutex> guard(stateMutex_);
    ++sequence_;
    drawDistance_ = drawDistance;
    horizontal_ = horizontal;
    core_.setMeasurementEpsilon(measurementEpsilon);
    itemCount_ = std::max(0, toIndex(itemCount));
    core_.setItemCount(itemCount_);
    core_.setEstimate(estimatedItemSize);
    core_.setColumnCount(std::max(1, toIndex(numColumns)));
  }
  maybeEmitRange();
}

void HybridNitroListEngine::updateData(const std::shared_ptr<ArrayBuffer>& config,
    const std::shared_ptr<ArrayBuffer>& types, const std::shared_ptr<ArrayBuffer>& spans,
    const std::shared_ptr<ArrayBuffer>& fixedSizes, const std::shared_ptr<ArrayBuffer>& remap) {
  int32_t configCount = 0, typesCapacity = 0, spansCapacity = 0, fixedCapacity = 0, remapCapacity = 0;
  const auto* c = doublesOf(config, configCount);
  const auto* t = shortsOf(types, typesCapacity);
  const auto* s = shortsOf(spans, spansCapacity);
  const auto* f = doublesOf(fixedSizes, fixedCapacity);
  const auto* r = doublesOf(remap, remapCapacity);
  if (c == nullptr || configCount != 17 || c[0] != 1) return;
  for (int32_t i = 0; i < configCount; ++i) if (!std::isfinite(c[i])) return;
  const int32_t count = std::max(0, toIndex(c[1]));
  const int32_t typeCount = toIndex(c[11]), fixedCount = toIndex(c[12]);
  const int32_t remapCount = toIndex(c[13]), spanCount = toIndex(c[14]);
  if (typeCount < 0 || typeCount > typesCapacity || c[15] < 0 || c[15] > typesCapacity - typeCount || fixedCount < 0 || fixedCount > fixedCapacity / 2 ||
      remapCount < 0 || remapCount > remapCapacity / 2 || spanCount < 0 || spanCount > spansCapacity || c[16] < 0 || c[16] > spansCapacity - spanCount) return;
  {
    std::lock_guard<std::mutex> guard(stateMutex_);
    if (c[8] < dataRevision_) return;
    drawDistance_ = c[3];
    horizontal_ = c[4] != 0;
    core_.setMeasurementEpsilon(c[6]);
    core_.setEstimate(c[2]);
    // Preserve old tail sources until every surviving measurement has moved.
    if (count > itemCount_) core_.setItemCount(count);
    if (c[7] != 0) core_.invalidateItemSizesFrom(0, true);
    else if (remapCount > 0) core_.remapItemSizes(r, remapCount);
    else if (c[9] >= 0) core_.invalidateItemSizesFrom(toIndex(c[9]), false);
    core_.setItemCount(count);
    if (count < itemCount_) std::vector<double>().swap(pendingSnapshot_);
    itemCount_ = count;
    core_.setColumnCount(std::max(1, toIndex(c[5])));
    if (c[10] == 0) core_.setItemTypes(t == nullptr ? nullptr : t + toIndex(c[15]), typeCount);
    else if (c[10] > 0) core_.setItemTypesRange(toIndex(c[10]), t + toIndex(c[15]), typeCount);
    if (spanCount > 0) core_.setItemSpansRange(toIndex(c[16]), s + toIndex(c[16]), spanCount);
    if (fixedCount > 0) core_.setItemSizes(f, fixedCount, 1.0);
    dataRevision_ = c[8];
  }
  maybeEmitRange();
}

void HybridNitroListEngine::setScrollOffset(double offset) {
  {
    std::lock_guard<std::mutex> guard(stateMutex_);
    if (offset == scrollOffset_) {
      return;
    }
    scrollOffset_ = offset;
    ++sequence_;
  }
  maybeEmitRange();
}

double HybridNitroListEngine::setScrollOffsetAndFill(double offset,
                                                     const std::shared_ptr<ArrayBuffer>& slab) {
  int32_t capacity = 0;
  auto* out = const_cast<double*>(doublesOf(slab, capacity));
  if (out == nullptr || capacity < 12) return -1;
  std::lock_guard<std::mutex> guard(stateMutex_);
  scrollOffset_ = offset;
  return fillSnapshotLocked(out, capacity);
}

double HybridNitroListEngine::fillSnapshotLocked(double* out, int32_t capacity, double anchorDelta) {
  constexpr int32_t header = 12;
  if (out == nullptr || capacity < header) return -1;
  const auto range = core_.getEngagedRange(scrollOffset_, mainViewportLocked(), drawDistance_);
  const int32_t count = std::max(0, range.end - range.start + 1);
  const int32_t required = header + count * 2;
  const bool insufficient = capacity < required;
  double* target = out;
  if (insufficient) {
    pendingSnapshot_.resize(required);
    target = pendingSnapshot_.data();
  }
  // Offset eight leaves the core payload at offset twelve. Move only its header.
  const int32_t written = core_.fillLayoutSlab(target + 8, required - 8,
      scrollOffset_, mainViewportLocked(), drawDistance_, 1.0);
  if (written < 0) return -1;
  std::copy_n(target + 8, 4, target);
  const bool changed = range.start != lastStart_ || range.end != lastEnd_ || range.version != lastVersion_;
  target[4] = 1; target[5] = header; target[6] = dataRevision_; target[7] = ++sequence_;
  target[8] = scrollOffset_; target[9] = anchorDelta;
  target[10] = count == 0 ? 2 : changed ? 1 : 0; target[11] = required;
  lastStart_ = range.start; lastEnd_ = range.end; lastVersion_ = range.version;
  if (insufficient) {
    std::copy_n(target, header, out);
    out[10] = -1;
    return -1;
  }
  if (pendingSnapshot_.capacity() != 0) std::vector<double>().swap(pendingSnapshot_);
  return written;
}

double HybridNitroListEngine::setItemSizesAndFill(const std::shared_ptr<ArrayBuffer>& pairs,
    double pairCount, double anchorIndex, double dataRevision, const std::shared_ptr<ArrayBuffer>& slab) {
  int32_t capacity = 0, pairCapacity = 0;
  auto* out = const_cast<double*>(doublesOf(slab, capacity));
  const auto* data = doublesOf(pairs, pairCapacity);
  if (out == nullptr || capacity < 12 || !std::isfinite(pairCount) || pairCount < 0 ||
      pairCount != std::floor(pairCount) || pairCount > pairCapacity / 2) return -2;
  std::lock_guard<std::mutex> guard(stateMutex_);
  if (dataRevision != dataRevision_) return -2;
  const double delta = anchorIndex >= 0
      ? core_.setItemSizesAnchored(data, toIndex(pairCount), 1.0, toIndex(anchorIndex))
      : (core_.setItemSizes(data, toIndex(pairCount), 1.0), 0.0);
  return fillSnapshotLocked(out, capacity, delta);
}

double HybridNitroListEngine::readSnapshot(double sequence, const std::shared_ptr<ArrayBuffer>& slab) {
  int32_t capacity = 0;
  auto* out = const_cast<double*>(doublesOf(slab, capacity));
  std::lock_guard<std::mutex> guard(stateMutex_);
  if (out == nullptr || pendingSnapshot_.empty() || pendingSnapshot_[7] != sequence ||
      sequence_ != sequence || pendingSnapshot_[6] != dataRevision_ ||
      pendingSnapshot_[0] != core_.getLayoutVersion() || pendingSnapshot_[8] != scrollOffset_) return -2;
  if (capacity < static_cast<int32_t>(pendingSnapshot_.size())) return -1;
  std::copy(pendingSnapshot_.begin(), pendingSnapshot_.end(), out);
  return std::max(0.0, out[3] - out[2] + 1);
}

void HybridNitroListEngine::resetScrollVelocity() {
  std::unique_lock<std::mutex> stateGuard(stateMutex_);
  ++sequence_;
  core_.resetScrollVelocity();
}

void HybridNitroListEngine::setEstimatesFrozen(bool frozen) {
  std::unique_lock<std::mutex> stateGuard(stateMutex_);
  if (core_.setEstimatesFrozen(frozen)) {
    stateGuard.unlock();
    maybeEmitRange();
  }
}

void HybridNitroListEngine::setViewport(double width, double height) {
  {
    std::lock_guard<std::mutex> guard(stateMutex_);
    if (width == viewportWidth_ && height == viewportHeight_) {
      return;
    }
    ++sequence_;
    viewportWidth_ = width;
    viewportHeight_ = height;
  }
  maybeEmitRange();
}

void HybridNitroListEngine::setItemSize(double index, double size) {
  std::unique_lock<std::mutex> stateGuard(stateMutex_);
  if (core_.setItemSize(toIndex(index), size)) {
    stateGuard.unlock();
    maybeEmitRange();
  }
}

void HybridNitroListEngine::setItemSizesBatch(const std::shared_ptr<ArrayBuffer>& pairs,
                                              bool emitRange) {
  std::unique_lock<std::mutex> stateGuard(stateMutex_);
  int32_t doubles = 0;
  const double* data = doublesOf(pairs, doubles);
  const int32_t pairCount = doubles / 2;
  if (data == nullptr || pairCount == 0) {
    return;
  }
  if (!core_.setItemSizes(data, pairCount, 1.0)) {
    return;
  }
  if (emitRange) {
    stateGuard.unlock();
    maybeEmitRange();
  }
}

double HybridNitroListEngine::setItemSizesBatchAnchored(const std::shared_ptr<ArrayBuffer>& pairs,
                                                        double anchorIndex, bool emitRange) {
  std::unique_lock<std::mutex> stateGuard(stateMutex_);
  int32_t doubles = 0;
  const double* data = doublesOf(pairs, doubles);
  const int32_t pairCount = doubles / 2;
  if (data == nullptr || pairCount == 0) {
    return 0.0;
  }
  const double diff = core_.setItemSizesAnchored(data, pairCount, 1.0, toIndex(anchorIndex));
  if (emitRange) {
    stateGuard.unlock();
    maybeEmitRange();
  }
  return diff;
}

void HybridNitroListEngine::resetItemSizes() {
  std::unique_lock<std::mutex> stateGuard(stateMutex_);
  if (core_.resetItemSizes()) {
    stateGuard.unlock();
    maybeEmitRange();
  }
}

void HybridNitroListEngine::remapItemSizes(const std::shared_ptr<ArrayBuffer>& pairs) {
  std::unique_lock<std::mutex> stateGuard(stateMutex_);
  int32_t doubles = 0;
  const double* data = doublesOf(pairs, doubles);
  const int32_t pairCount = doubles / 2;
  if (data == nullptr || pairCount == 0) {
    return;
  }
  if (core_.remapItemSizes(data, pairCount)) {
    stateGuard.unlock();
    maybeEmitRange();
  }
}

bool HybridNitroListEngine::setItemTypes(const std::shared_ptr<ArrayBuffer>& types) {
  std::unique_lock<std::mutex> stateGuard(stateMutex_);
  int32_t count = 0;
  const uint16_t* data = shortsOf(types, count);
  const bool allTracked = core_.setItemTypes(count == 0 ? nullptr : data, count);
  stateGuard.unlock();
    maybeEmitRange();
  return allTracked;
}

bool HybridNitroListEngine::setItemTypesRange(double start,
                                              const std::shared_ptr<ArrayBuffer>& types) {
  std::unique_lock<std::mutex> stateGuard(stateMutex_);
  int32_t count = 0;
  const uint16_t* data = shortsOf(types, count);
  if (data == nullptr || count == 0) {
    return true;
  }
  const bool allTracked = core_.setItemTypesRange(toIndex(start), data, count);
  stateGuard.unlock();
    maybeEmitRange();
  return allTracked;
}

void HybridNitroListEngine::setItemSpans(const std::shared_ptr<ArrayBuffer>& spans) {
  std::unique_lock<std::mutex> stateGuard(stateMutex_);
  int32_t count = 0;
  const uint16_t* data = shortsOf(spans, count);
  if (core_.setItemSpans(count == 0 ? nullptr : data, count)) {
    stateGuard.unlock();
    maybeEmitRange();
  }
}

void HybridNitroListEngine::seedTypeMeans(const std::shared_ptr<ArrayBuffer>& pairs) {
  std::unique_lock<std::mutex> stateGuard(stateMutex_);
  int32_t doubles = 0;
  const double* data = doublesOf(pairs, doubles);
  const int32_t pairCount = doubles / 2;
  if (data == nullptr || pairCount == 0) {
    return;
  }
  if (core_.seedTypeMeans(data, pairCount, 1.0)) {
    stateGuard.unlock();
    maybeEmitRange();
  }
}

double HybridNitroListEngine::fillLayoutSlab(const std::shared_ptr<ArrayBuffer>& slab) {
  int32_t capacity = 0;
  auto* out = const_cast<double*>(doublesOf(slab, capacity));
  if (out == nullptr || capacity == 0) {
    return -1.0;
  }
  std::lock_guard<std::mutex> guard(stateMutex_);
  return fillSnapshotLocked(out, capacity);
}

double HybridNitroListEngine::fillTypeStats(const std::shared_ptr<ArrayBuffer>& out) {
  std::unique_lock<std::mutex> stateGuard(stateMutex_);
  int32_t capacity = 0;
  auto* data = const_cast<double*>(doublesOf(out, capacity));
  if (data == nullptr || capacity == 0) {
    return -1.0;
  }
  return static_cast<double>(core_.fillTypeStats(data, capacity, 1.0));
}

double HybridNitroListEngine::countUnmeasured(double from, double to) {
  std::unique_lock<std::mutex> stateGuard(stateMutex_);
  return static_cast<double>(core_.countUnmeasured(toIndex(from), toIndex(to)));
}

double HybridNitroListEngine::getItemOffset(double index) {
  std::unique_lock<std::mutex> stateGuard(stateMutex_);
  return core_.getOffset(toIndex(index));
}

double HybridNitroListEngine::getItemSize(double index) {
  std::unique_lock<std::mutex> stateGuard(stateMutex_);
  return core_.getSize(toIndex(index));
}

double HybridNitroListEngine::getTotalSize() {
  std::unique_lock<std::mutex> stateGuard(stateMutex_);
  return core_.getTotalSize();
}

double HybridNitroListEngine::readLayout(double start, double count,
                                         const std::shared_ptr<ArrayBuffer>& out) {
  constexpr int32_t header = 8;
  int32_t capacity = 0;
  auto* target = const_cast<double*>(doublesOf(out, capacity));
  if (target == nullptr || capacity < header || !std::isfinite(start) || !std::isfinite(count) ||
      start != std::floor(start) || count != std::floor(count) || count < 0) return -2;
  std::lock_guard<std::mutex> guard(stateMutex_);
  const int32_t written = core_.readLayout(toIndex(start), toIndex(count), target + 4, capacity - 4);
  target[0] = 1;
  target[1] = header;
  target[2] = dataRevision_;
  target[3] = header + target[7] * 2;
  return written;
}

void HybridNitroListEngine::dispose() {
  std::optional<RangeCallback> released;
  {
    std::lock_guard<std::mutex> guard(stateMutex_);
    released.swap(onRangeChange_);
    std::vector<double>().swap(pendingSnapshot_);
    itemCount_ = 0;
    lastStart_ = -1;
    lastEnd_ = -2;
    lastVersion_ = -1;
    ++sequence_;
    core_.resetAll();
  }
}

size_t HybridNitroListEngine::getExternalMemorySize() noexcept {
  try {
    std::lock_guard<std::mutex> guard(stateMutex_);
    return core_.getMemoryFootprint() + pendingSnapshot_.capacity() * sizeof(double);
  } catch (...) {
    return 0;
  }
}

}
