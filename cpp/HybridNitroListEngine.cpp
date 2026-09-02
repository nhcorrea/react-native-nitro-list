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
    drawDistance_ = drawDistance;
    horizontal_ = horizontal;
  }
  core_.setMeasurementEpsilon(measurementEpsilon);
  core_.setItemCount(std::max(0, toIndex(itemCount)));
  core_.setEstimate(estimatedItemSize);
  core_.setColumnCount(std::max(1, toIndex(numColumns)));
  maybeEmitRange();
}

void HybridNitroListEngine::setScrollOffset(double offset) {
  {
    std::lock_guard<std::mutex> guard(stateMutex_);
    if (offset == scrollOffset_) {
      return;
    }
    scrollOffset_ = offset;
  }
  maybeEmitRange();
}

double HybridNitroListEngine::setScrollOffsetAndFill(double offset,
                                                     const std::shared_ptr<ArrayBuffer>& slab) {
  int32_t capacity = 0;
  auto* out = const_cast<double*>(doublesOf(slab, capacity));
  if (out == nullptr || capacity == 0) {
    return -1.0;
  }
  std::lock_guard<std::mutex> guard(stateMutex_);
  scrollOffset_ = offset;
  const int32_t written =
      core_.fillLayoutSlab(out, capacity, scrollOffset_, mainViewportLocked(), drawDistance_, 1.0);
  if (written < 0) {
    return -1.0;
  }
  const auto version = static_cast<int32_t>(out[0]);
  const auto start = static_cast<int32_t>(out[2]);
  const auto end = static_cast<int32_t>(out[3]);
  if (start == lastStart_ && end == lastEnd_ && version == lastVersion_) {
    return 0.0;
  }
  lastStart_ = start;
  lastEnd_ = end;
  lastVersion_ = version;
  return static_cast<double>(written);
}

void HybridNitroListEngine::resetScrollVelocity() {
  core_.resetScrollVelocity();
}

void HybridNitroListEngine::setEstimatesFrozen(bool frozen) {
  if (core_.setEstimatesFrozen(frozen)) {
    maybeEmitRange();
  }
}

void HybridNitroListEngine::setViewport(double width, double height) {
  {
    std::lock_guard<std::mutex> guard(stateMutex_);
    if (width == viewportWidth_ && height == viewportHeight_) {
      return;
    }
    viewportWidth_ = width;
    viewportHeight_ = height;
  }
  maybeEmitRange();
}

void HybridNitroListEngine::setItemSize(double index, double size) {
  if (core_.setItemSize(toIndex(index), size)) {
    maybeEmitRange();
  }
}

void HybridNitroListEngine::setItemSizesBatch(const std::shared_ptr<ArrayBuffer>& pairs,
                                              bool emitRange) {
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
    maybeEmitRange();
  }
}

double HybridNitroListEngine::setItemSizesBatchAnchored(const std::shared_ptr<ArrayBuffer>& pairs,
                                                        double anchorIndex, bool emitRange) {
  int32_t doubles = 0;
  const double* data = doublesOf(pairs, doubles);
  const int32_t pairCount = doubles / 2;
  if (data == nullptr || pairCount == 0) {
    return 0.0;
  }
  const double diff = core_.setItemSizesAnchored(data, pairCount, 1.0, toIndex(anchorIndex));
  if (emitRange) {
    maybeEmitRange();
  }
  return diff;
}

void HybridNitroListEngine::resetItemSizes() {
  if (core_.resetItemSizes()) {
    maybeEmitRange();
  }
}

void HybridNitroListEngine::remapItemSizes(const std::shared_ptr<ArrayBuffer>& pairs) {
  int32_t doubles = 0;
  const double* data = doublesOf(pairs, doubles);
  const int32_t pairCount = doubles / 2;
  if (data == nullptr || pairCount == 0) {
    return;
  }
  if (core_.remapItemSizes(data, pairCount)) {
    maybeEmitRange();
  }
}

bool HybridNitroListEngine::setItemTypes(const std::shared_ptr<ArrayBuffer>& types) {
  int32_t count = 0;
  const uint16_t* data = shortsOf(types, count);
  const bool allTracked = core_.setItemTypes(count == 0 ? nullptr : data, count);
  maybeEmitRange();
  return allTracked;
}

bool HybridNitroListEngine::setItemTypesRange(double start,
                                              const std::shared_ptr<ArrayBuffer>& types) {
  int32_t count = 0;
  const uint16_t* data = shortsOf(types, count);
  if (data == nullptr || count == 0) {
    return true;
  }
  const bool allTracked = core_.setItemTypesRange(toIndex(start), data, count);
  maybeEmitRange();
  return allTracked;
}

void HybridNitroListEngine::setItemSpans(const std::shared_ptr<ArrayBuffer>& spans) {
  int32_t count = 0;
  const uint16_t* data = shortsOf(spans, count);
  if (core_.setItemSpans(count == 0 ? nullptr : data, count)) {
    maybeEmitRange();
  }
}

void HybridNitroListEngine::seedTypeMeans(const std::shared_ptr<ArrayBuffer>& pairs) {
  int32_t doubles = 0;
  const double* data = doublesOf(pairs, doubles);
  const int32_t pairCount = doubles / 2;
  if (data == nullptr || pairCount == 0) {
    return;
  }
  if (core_.seedTypeMeans(data, pairCount, 1.0)) {
    maybeEmitRange();
  }
}

double HybridNitroListEngine::fillLayoutSlab(const std::shared_ptr<ArrayBuffer>& slab) {
  int32_t capacity = 0;
  auto* out = const_cast<double*>(doublesOf(slab, capacity));
  if (out == nullptr || capacity == 0) {
    return -1.0;
  }
  double offset;
  double viewport;
  double draw;
  {
    std::lock_guard<std::mutex> guard(stateMutex_);
    offset = scrollOffset_;
    viewport = mainViewportLocked();
    draw = drawDistance_;
  }
  return static_cast<double>(core_.fillLayoutSlab(out, capacity, offset, viewport, draw, 1.0));
}

double HybridNitroListEngine::fillTypeStats(const std::shared_ptr<ArrayBuffer>& out) {
  int32_t capacity = 0;
  auto* data = const_cast<double*>(doublesOf(out, capacity));
  if (data == nullptr || capacity == 0) {
    return -1.0;
  }
  return static_cast<double>(core_.fillTypeStats(data, capacity, 1.0));
}

double HybridNitroListEngine::countUnmeasured(double from, double to) {
  return static_cast<double>(core_.countUnmeasured(toIndex(from), toIndex(to)));
}

double HybridNitroListEngine::getItemOffset(double index) {
  return core_.getOffset(toIndex(index));
}

double HybridNitroListEngine::getItemSize(double index) {
  return core_.getSize(toIndex(index));
}

double HybridNitroListEngine::getTotalSize() {
  return core_.getTotalSize();
}

size_t HybridNitroListEngine::getExternalMemorySize() noexcept {
  try {
    return core_.getMemoryFootprint();
  } catch (...) {
    return 0;
  }
}

}
