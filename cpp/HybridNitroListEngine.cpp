#include "HybridNitroListEngine.hpp"

#include <algorithm>
#include <cmath>
#include <cstring>
#include <limits>

namespace margelo::nitro::nitrolist {

namespace {

int32_t toIndex(double value) {
  if (std::isnan(value)) {
    return std::numeric_limits<int32_t>::min();
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

const int32_t* intsOf(const std::shared_ptr<ArrayBuffer>& buffer, int32_t& countOut) {
  if (buffer == nullptr) {
    countOut = 0;
    return nullptr;
  }
  countOut = static_cast<int32_t>(buffer->size() / sizeof(int32_t));
  return reinterpret_cast<const int32_t*>(buffer->data());
}

} // namespace

HybridNitroListEngine::HybridNitroListEngine()
    : HybridObject(TAG), state_(std::make_shared<EngineCoreState>()) {
  state_->core.setTypeAverages(true);
  state_->core.setDirectionalBuffers(true);
  state_->core.setLazyTypeMeans(true);
  engineId_ = EngineRegistry::instance().registerState(state_);
}

HybridNitroListEngine::~HybridNitroListEngine() {
  if (engineId_ > 0) {
    EngineRegistry::instance().unregisterState(engineId_);
    engineId_ = 0;
  }
  if (state_ != nullptr) {
    std::lock_guard<std::mutex> guard(state_->stateMutex);
    state_->disposed = true;
  }
}

void HybridNitroListEngine::mirrorTypesLocked(int32_t start, const uint16_t* types, int32_t count,
                                              bool replaceAll) {
  if (state_->itemCount <= 0) {
    state_->itemTypes.clear();
    return;
  }
  if (static_cast<int32_t>(state_->itemTypes.size()) != state_->itemCount) {
    state_->itemTypes.resize(static_cast<size_t>(state_->itemCount), 0);
  }
  if (replaceAll) {
    const int32_t copyCount = types != nullptr ? std::min(state_->itemCount, std::max(0, count)) : 0;
    if (copyCount > 0) {
      std::copy_n(types, copyCount, state_->itemTypes.data());
    }
    if (copyCount < state_->itemCount) {
      std::fill(state_->itemTypes.begin() + copyCount, state_->itemTypes.end(), 0);
    }
    return;
  }
  if (start < 0 || start >= state_->itemCount || count <= 0) return;
  const int32_t copyCount = std::min(state_->itemCount - start, count);
  if (types != nullptr) {
    std::copy_n(types, copyCount, state_->itemTypes.data() + start);
  } else {
    std::fill(state_->itemTypes.begin() + start, state_->itemTypes.begin() + start + copyCount, 0);
  }
}

void HybridNitroListEngine::maybeEmitRange() {
  std::optional<RangeCallback> callback;
  int32_t start = 0;
  int32_t end = -1;
  int32_t version = 0;
  double offset = 0.0;
  {
    std::lock_guard<std::mutex> guard(state_->stateMutex);
    if (!onRangeChange_.has_value()) {
      return;
    }
    const LayoutCore::EngagedRange range =
        state_->core.getEngagedRange(state_->scrollOffset, state_->mainViewportLocked(), state_->drawDistance);
    if (range.start == state_->lastStart && range.end == state_->lastEnd &&
        range.version == state_->lastVersion) {
      return;
    }
    state_->lastStart = range.start;
    state_->lastEnd = range.end;
    state_->lastVersion = range.version;
    start = range.start;
    end = range.end;
    version = range.version;
    offset = state_->scrollOffset;
    callback = onRangeChange_;
    ++sequence_;
  }
  (*callback)(static_cast<double>(start), static_cast<double>(end), static_cast<double>(version),
              offset);
}

std::optional<HybridNitroListEngine::RangeCallback> HybridNitroListEngine::getOnRangeChange() {
  std::lock_guard<std::mutex> guard(state_->stateMutex);
  return onRangeChange_;
}

void HybridNitroListEngine::setOnRangeChange(const std::optional<RangeCallback>& onRangeChange) {
  {
    std::lock_guard<std::mutex> guard(state_->stateMutex);
    onRangeChange_ = onRangeChange;
    state_->lastStart = -1;
    state_->lastEnd = -2;
    state_->lastVersion = -1;
  }
  maybeEmitRange();
}

void HybridNitroListEngine::configure(double itemCount, double estimatedItemSize,
                                      double drawDistance, bool horizontal, double numColumns,
                                      double measurementEpsilon) {
  if (!std::isfinite(itemCount) || !std::isfinite(estimatedItemSize) || !std::isfinite(drawDistance) ||
      !std::isfinite(numColumns) || !std::isfinite(measurementEpsilon)) {
    return;
  }
  {
    std::lock_guard<std::mutex> guard(state_->stateMutex);
    ++sequence_;
    state_->drawDistance = std::max(0.0, drawDistance);
    state_->horizontal = horizontal;
    state_->core.setMeasurementEpsilon(measurementEpsilon);
    state_->itemCount = std::max(0, toIndex(itemCount));
    state_->core.setItemCount(state_->itemCount);
    state_->core.setEstimate(std::max(0.0, estimatedItemSize));
    state_->numColumns = std::max(1, toIndex(numColumns));
    state_->core.setColumnCount(state_->numColumns);
    state_->committedStart = -1;
    state_->committedEnd = -2;
    if (static_cast<int32_t>(state_->itemTypes.size()) != state_->itemCount) {
      state_->itemTypes.resize(static_cast<size_t>(state_->itemCount), 0);
    }
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
  if (c == nullptr || (configCount != 17 && configCount != 18) || c[0] != 1) return;
  for (int32_t i = 0; i < configCount; ++i) if (!std::isfinite(c[i])) return;
  const int32_t count = std::max(0, toIndex(c[1]));
  const int32_t typeCount = toIndex(c[11]), fixedCount = toIndex(c[12]);
  const int32_t remapCount = toIndex(c[13]), spanCount = toIndex(c[14]);
  if (typeCount < 0 || typeCount > typesCapacity || c[15] < 0 || c[15] > typesCapacity - typeCount ||
      fixedCount < 0 || fixedCount > fixedCapacity / 2 ||
      remapCount < 0 || remapCount > remapCapacity / 2 || spanCount < 0 || spanCount > spansCapacity ||
      c[16] < 0 || c[16] > spansCapacity - spanCount) return;
  {
    std::lock_guard<std::mutex> guard(state_->stateMutex);
    if (c[8] < state_->dataRevision) return;
    if (configCount == 18) state_->core.setLazyTypeMeans(c[17] != 0);
    state_->drawDistance = std::max(0.0, c[3]);
    state_->horizontal = c[4] != 0;
    state_->core.setMeasurementEpsilon(c[6]);
    state_->core.setEstimate(std::max(0.0, c[2]));
    const int32_t prevCount = state_->itemCount;
    // Capture MVCP anchor atomically BEFORE remap so UI thread never sees shifted offsets without the matching MVCP shift!
    int32_t remapOldAnchor = -1;
    int32_t remapNewAnchor = -1;
    double remapOldOffset = 0.0;
    if (c[7] == 0 && remapCount > 0 && state_->mvcpEnabled && state_->mvcpDataEnabled &&
        state_->slotPool.slotCount() > 0 && prevCount > 0) {
      if (state_->mvcpAnchorIndex >= 0 && state_->mvcpAnchorIndex < prevCount) {
        remapOldAnchor = state_->mvcpAnchorIndex;
      } else {
        const auto vis = state_->core.getEngagedRange(
            std::max(0.0, state_->scrollOffset), std::max(1.0, state_->mainViewportLocked()), 0.0);
        if (vis.start >= 0 && vis.start < prevCount) {
          remapOldAnchor = vis.start;
        }
      }
      if (remapOldAnchor >= 0) {
        // Check O(1) contiguous shift fast-path first, then linear lookup in remap pairs.
        const int32_t p0Old = toIndex(r[0]);
        const int32_t guessIdx = remapOldAnchor - p0Old;
        if (guessIdx >= 0 && guessIdx < remapCount &&
            toIndex(r[guessIdx * 2]) == remapOldAnchor) {
          remapNewAnchor = toIndex(r[guessIdx * 2 + 1]);
        } else {
          for (int32_t p = 0; p < remapCount; ++p) {
            if (toIndex(r[p * 2]) == remapOldAnchor) {
              remapNewAnchor = toIndex(r[p * 2 + 1]);
              break;
            }
          }
        }
        if (remapNewAnchor >= 0 && remapNewAnchor < count) {
          remapOldOffset = state_->core.getOffset(remapOldAnchor);
        } else {
          remapOldAnchor = -1;
          remapNewAnchor = -1;
        }
      }
    }
    if (count > prevCount) state_->core.setItemCount(count);
    if (c[7] != 0) {
      state_->core.invalidateItemSizesFrom(0, true);
      state_->slotPool.reset();
    } else if (remapCount > 0) {
      state_->core.remapItemSizes(r, remapCount);
      state_->slotPool.remapIndices(r, remapCount, count);
    } else if (c[9] >= 0) {
      const int32_t invFrom = toIndex(c[9]);
      state_->core.invalidateItemSizesFrom(invFrom, false, f, fixedCount);
      state_->slotPool.invalidateRange(invFrom, std::max(prevCount, count));
    }
    state_->core.setItemCount(count);
    if (count < prevCount) std::vector<double>().swap(pendingSnapshot_);
    state_->itemCount = count;
    state_->numColumns = std::max(1, toIndex(c[5]));
    state_->core.setColumnCount(state_->numColumns);
    if (c[10] == 0) {
      const uint16_t* tPtr = t == nullptr ? nullptr : t + toIndex(c[15]);
      state_->core.setItemTypes(tPtr, typeCount);
      mirrorTypesLocked(0, tPtr, typeCount, true);
    } else if (c[10] > 0) {
      const int32_t start = toIndex(c[10]);
      const uint16_t* tPtr = t + toIndex(c[15]);
      state_->core.setItemTypesRange(start, tPtr, typeCount);
      mirrorTypesLocked(start, tPtr, typeCount, false);
    } else if (static_cast<int32_t>(state_->itemTypes.size()) != count) {
      state_->itemTypes.resize(static_cast<size_t>(count), 0);
    }
    if (spanCount > 0) state_->core.setItemSpansRange(toIndex(c[16]), s + toIndex(c[16]), spanCount);
    if (fixedCount > 0) state_->core.setItemSizes(f, fixedCount, 1.0);
    if (remapNewAnchor >= 0 && remapNewAnchor < count) {
      const double newOffset = state_->core.getOffset(remapNewAnchor);
      const double deltaDp = newOffset - remapOldOffset;
      state_->mvcpAnchorIndex = remapNewAnchor;
      state_->mvcpAnchorOffsetDp = newOffset;
      if (std::abs(deltaDp) > 0.1) {
        state_->pendingExternalMvcpShiftDp += deltaDp;
        state_->scrollOffset = std::max(0.0, state_->scrollOffset + deltaDp);
      }
    }
    state_->committedStart = -1;
    state_->committedEnd = -2;
    state_->dataRevision = c[8];
  }
  maybeEmitRange();
}

void HybridNitroListEngine::setScrollOffset(double offset) {
  if (!std::isfinite(offset)) {
    return;
  }
  {
    std::lock_guard<std::mutex> guard(state_->stateMutex);
    if (offset == state_->scrollOffset) {
      return;
    }
    state_->scrollOffset = offset;
    ++sequence_;
  }
  maybeEmitRange();
}

double HybridNitroListEngine::setScrollOffsetAndFill(double offset,
                                                     const std::shared_ptr<ArrayBuffer>& slab) {
  int32_t capacity = 0;
  auto* out = const_cast<double*>(doublesOf(slab, capacity));
  if (out == nullptr || capacity < 12) return -1;
  if (!std::isfinite(offset)) return -2;
  std::lock_guard<std::mutex> guard(state_->stateMutex);
  state_->scrollOffset = offset;
  return fillSnapshotLocked(out, capacity, 0.0, true);
}

double HybridNitroListEngine::fillSnapshotLocked(double* out, int32_t capacity, double anchorDelta,
                                                 bool allowSkipBody) {
  constexpr int32_t header = 12;
  if (out == nullptr || capacity < header) return -1;
  const bool callerHasLastBody = allowSkipBody &&
      out[4] == 1 && out[5] == header && out[6] == state_->dataRevision && out[10] >= 0 &&
      out[0] == static_cast<double>(state_->lastVersion) &&
      out[2] == static_cast<double>(state_->lastStart) &&
      out[3] == static_cast<double>(state_->lastEnd);
  const LayoutCore::SlabResult result = state_->core.fillSnapshotSlab(
      out + header, capacity - header, state_->scrollOffset, state_->mainViewportLocked(),
      state_->drawDistance, 1.0, callerHasLastBody, state_->lastStart, state_->lastEnd,
      state_->lastVersion, &pendingSnapshot_, header);
  const auto& range = result.range;
  const int32_t count = result.count;
  const int32_t required = header + count * 2;
  const bool changed = range.start != state_->lastStart || range.end != state_->lastEnd ||
                       range.version != state_->lastVersion;
  double* target = result.insufficient ? pendingSnapshot_.data() : out;
  target[0] = range.version;
  target[1] = result.totalSize;
  target[2] = range.start;
  target[3] = range.end;
  target[4] = 1;
  target[5] = header;
  target[6] = state_->dataRevision;
  target[7] = ++sequence_;
  target[8] = state_->scrollOffset;
  target[9] = anchorDelta;
  target[10] = count == 0 ? 2 : changed ? 1 : 0;
  target[11] = required;
  state_->lastStart = range.start;
  state_->lastEnd = range.end;
  state_->lastVersion = range.version;
  if (result.insufficient) {
    std::copy_n(target, header, out);
    out[10] = -1;
    return -1;
  }
  if (pendingSnapshot_.capacity() != 0) std::vector<double>().swap(pendingSnapshot_);
  return count;
}

double HybridNitroListEngine::setItemSizesAndFill(const std::shared_ptr<ArrayBuffer>& pairs,
    double pairCount, double anchorIndex, double dataRevision, const std::shared_ptr<ArrayBuffer>& slab) {
  int32_t capacity = 0, pairCapacity = 0;
  auto* out = const_cast<double*>(doublesOf(slab, capacity));
  const auto* data = doublesOf(pairs, pairCapacity);
  if (out == nullptr || capacity < 12 || !std::isfinite(pairCount) || pairCount < 0 ||
      pairCount != std::floor(pairCount) || pairCount > pairCapacity / 2) return -2;
  std::lock_guard<std::mutex> guard(state_->stateMutex);
  if (dataRevision != state_->dataRevision) return -2;
  const double delta = anchorIndex >= 0
      ? state_->core.setItemSizesAnchored(data, toIndex(pairCount), 1.0, toIndex(anchorIndex))
      : (state_->core.setItemSizes(data, toIndex(pairCount), 1.0), 0.0);
  return fillSnapshotLocked(out, capacity, delta);
}

double HybridNitroListEngine::readSnapshot(double sequence, const std::shared_ptr<ArrayBuffer>& slab) {
  int32_t capacity = 0;
  auto* out = const_cast<double*>(doublesOf(slab, capacity));
  std::lock_guard<std::mutex> guard(state_->stateMutex);
  if (out == nullptr || pendingSnapshot_.empty() || pendingSnapshot_[7] != sequence ||
      sequence_ != sequence || pendingSnapshot_[6] != state_->dataRevision ||
      pendingSnapshot_[0] != state_->core.getLayoutVersion() ||
      pendingSnapshot_[8] != state_->scrollOffset) return -2;
  if (capacity < static_cast<int32_t>(pendingSnapshot_.size())) return -1;
  std::copy(pendingSnapshot_.begin(), pendingSnapshot_.end(), out);
  return std::max(0.0, out[3] - out[2] + 1);
}

void HybridNitroListEngine::resetScrollVelocity() {
  std::unique_lock<std::mutex> stateGuard(state_->stateMutex);
  ++sequence_;
  state_->core.resetScrollVelocity();
}

void HybridNitroListEngine::setEstimatesFrozen(bool frozen) {
  std::unique_lock<std::mutex> stateGuard(state_->stateMutex);
  int32_t anchorIdx = -1;
  double oldOffset = 0.0;
  if (!frozen && state_->mvcpEnabled && !state_->jsPrewarmActive &&
      state_->slotPool.slotCount() > 0 && state_->itemCount > 0) {
    if (state_->mvcpAnchorIndex >= 0 && state_->mvcpAnchorIndex < state_->itemCount) {
      anchorIdx = state_->mvcpAnchorIndex;
    } else {
      const auto vis = state_->core.getEngagedRange(
          std::max(0.0, state_->scrollOffset), std::max(1.0, state_->mainViewportLocked()), 0.0);
      if (vis.start >= 0 && vis.start < state_->itemCount) {
        anchorIdx = vis.start;
      }
    }
    if (anchorIdx >= 0) {
      oldOffset = state_->core.getOffset(anchorIdx);
    }
  }
  if (state_->core.setEstimatesFrozen(frozen)) {
    if (anchorIdx >= 0 && anchorIdx < state_->itemCount) {
      const double newOffset = state_->core.getOffset(anchorIdx);
      const double deltaDp = newOffset - oldOffset;
      state_->mvcpAnchorIndex = anchorIdx;
      state_->mvcpAnchorOffsetDp = newOffset;
      if (std::abs(deltaDp) > 0.1) {
        state_->pendingExternalMvcpShiftDp += deltaDp;
        state_->scrollOffset = std::max(0.0, state_->scrollOffset + deltaDp);
      }
    }
    stateGuard.unlock();
    maybeEmitRange();
  }
}

void HybridNitroListEngine::setViewport(double width, double height) {
  if (!std::isfinite(width) || !std::isfinite(height)) {
    return;
  }
  width = std::max(0.0, width);
  height = std::max(0.0, height);
  {
    std::lock_guard<std::mutex> guard(state_->stateMutex);
    if (width == state_->viewportWidth && height == state_->viewportHeight) {
      return;
    }
    ++sequence_;
    state_->viewportWidth = width;
    state_->viewportHeight = height;
    state_->committedStart = -1;
    state_->committedEnd = -2;
  }
  maybeEmitRange();
}

void HybridNitroListEngine::setItemSize(double index, double size) {
  std::unique_lock<std::mutex> stateGuard(state_->stateMutex);
  if (state_->core.setItemSize(toIndex(index), size)) {
    stateGuard.unlock();
    maybeEmitRange();
  }
}

void HybridNitroListEngine::setItemSizesBatch(const std::shared_ptr<ArrayBuffer>& pairs,
                                              bool emitRange) {
  std::unique_lock<std::mutex> stateGuard(state_->stateMutex);
  int32_t doubles = 0;
  const double* data = doublesOf(pairs, doubles);
  const int32_t pairCount = doubles / 2;
  if (data == nullptr || pairCount == 0) {
    return;
  }
  if (!state_->core.setItemSizes(data, pairCount, 1.0)) {
    return;
  }
  if (emitRange) {
    stateGuard.unlock();
    maybeEmitRange();
  }
}

double HybridNitroListEngine::setItemSizesBatchAnchored(const std::shared_ptr<ArrayBuffer>& pairs,
                                                        double anchorIndex, bool emitRange) {
  std::unique_lock<std::mutex> stateGuard(state_->stateMutex);
  int32_t doubles = 0;
  const double* data = doublesOf(pairs, doubles);
  const int32_t pairCount = doubles / 2;
  if (data == nullptr || pairCount == 0) {
    return 0.0;
  }
  const double diff = state_->core.setItemSizesAnchored(data, pairCount, 1.0, toIndex(anchorIndex));
  if (emitRange) {
    stateGuard.unlock();
    maybeEmitRange();
  }
  return diff;
}

void HybridNitroListEngine::resetItemSizes() {
  std::unique_lock<std::mutex> stateGuard(state_->stateMutex);
  if (state_->core.resetItemSizes()) {
    stateGuard.unlock();
    maybeEmitRange();
  }
}

void HybridNitroListEngine::remapItemSizes(const std::shared_ptr<ArrayBuffer>& pairs) {
  std::unique_lock<std::mutex> stateGuard(state_->stateMutex);
  int32_t doubles = 0;
  const double* data = doublesOf(pairs, doubles);
  const int32_t pairCount = doubles / 2;
  if (data == nullptr || pairCount == 0) {
    return;
  }
  state_->slotPool.remapIndices(data, pairCount, state_->itemCount);
  if (state_->core.remapItemSizes(data, pairCount)) {
    stateGuard.unlock();
    maybeEmitRange();
  }
}

bool HybridNitroListEngine::setItemTypes(const std::shared_ptr<ArrayBuffer>& types) {
  std::unique_lock<std::mutex> stateGuard(state_->stateMutex);
  int32_t count = 0;
  const uint16_t* data = shortsOf(types, count);
  const uint16_t* ptr = count == 0 ? nullptr : data;
  const bool allTracked = state_->core.setItemTypes(ptr, count);
  mirrorTypesLocked(0, ptr, count, true);
  stateGuard.unlock();
  maybeEmitRange();
  return allTracked;
}

bool HybridNitroListEngine::setItemTypesRange(double start,
                                              const std::shared_ptr<ArrayBuffer>& types) {
  std::unique_lock<std::mutex> stateGuard(state_->stateMutex);
  int32_t count = 0;
  const uint16_t* data = shortsOf(types, count);
  if (data == nullptr || count == 0) {
    return true;
  }
  const int32_t startIdx = toIndex(start);
  const bool allTracked = state_->core.setItemTypesRange(startIdx, data, count);
  mirrorTypesLocked(startIdx, data, count, false);
  stateGuard.unlock();
  maybeEmitRange();
  return allTracked;
}

void HybridNitroListEngine::setItemSpans(const std::shared_ptr<ArrayBuffer>& spans) {
  std::unique_lock<std::mutex> stateGuard(state_->stateMutex);
  int32_t count = 0;
  const uint16_t* data = shortsOf(spans, count);
  if (state_->core.setItemSpans(count == 0 ? nullptr : data, count)) {
    stateGuard.unlock();
    maybeEmitRange();
  }
}

void HybridNitroListEngine::seedTypeMeans(const std::shared_ptr<ArrayBuffer>& pairs) {
  std::unique_lock<std::mutex> stateGuard(state_->stateMutex);
  int32_t doubles = 0;
  const double* data = doublesOf(pairs, doubles);
  const int32_t pairCount = doubles / 2;
  if (data == nullptr || pairCount == 0) {
    return;
  }
  if (state_->core.seedTypeMeans(data, pairCount, 1.0)) {
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
  std::lock_guard<std::mutex> guard(state_->stateMutex);
  return fillSnapshotLocked(out, capacity);
}

double HybridNitroListEngine::fillTypeStats(const std::shared_ptr<ArrayBuffer>& out) {
  std::unique_lock<std::mutex> stateGuard(state_->stateMutex);
  int32_t capacity = 0;
  auto* data = const_cast<double*>(doublesOf(out, capacity));
  if (data == nullptr || capacity == 0) {
    return -1.0;
  }
  return static_cast<double>(state_->core.fillTypeStats(data, capacity, 1.0));
}

double HybridNitroListEngine::countUnmeasured(double from, double to) {
  std::unique_lock<std::mutex> stateGuard(state_->stateMutex);
  return static_cast<double>(state_->core.countUnmeasured(toIndex(from), toIndex(to)));
}

double HybridNitroListEngine::getItemOffset(double index) {
  std::unique_lock<std::mutex> stateGuard(state_->stateMutex);
  return state_->core.getOffset(toIndex(index));
}

double HybridNitroListEngine::getItemSize(double index) {
  std::unique_lock<std::mutex> stateGuard(state_->stateMutex);
  return state_->core.getSize(toIndex(index));
}

double HybridNitroListEngine::getTotalSize() {
  std::unique_lock<std::mutex> stateGuard(state_->stateMutex);
  return state_->core.getTotalSize();
}

double HybridNitroListEngine::readLayout(double start, double count,
                                         const std::shared_ptr<ArrayBuffer>& out) {
  constexpr int32_t header = 8;
  int32_t capacity = 0;
  auto* target = const_cast<double*>(doublesOf(out, capacity));
  if (target == nullptr || capacity < header || !std::isfinite(start) || !std::isfinite(count) ||
      start != std::floor(start) || count != std::floor(count) || count < 0) return -2;
  std::lock_guard<std::mutex> guard(state_->stateMutex);
  const int32_t written =
      state_->core.readLayout(toIndex(start), toIndex(count), target + 4, capacity - 4);
  target[0] = 1;
  target[1] = header;
  target[2] = state_->dataRevision;
  target[3] = header + target[7] * 2;
  return written;
}

double HybridNitroListEngine::getEngineId() {
  return static_cast<double>(engineId_);
}

void HybridNitroListEngine::configureSlots(double maxParked, double mainAxisGap,
                                           double paddingStart) {
  std::lock_guard<std::mutex> guard(state_->stateMutex);
  if (std::isfinite(maxParked)) {
    state_->slotPool.configure(std::max(0, toIndex(maxParked)));
  }
  if (std::isfinite(mainAxisGap)) {
    state_->mainAxisGap = std::max(0.0, mainAxisGap);
  }
  if (std::isfinite(paddingStart)) {
    state_->paddingStart = paddingStart;
  }
}

void HybridNitroListEngine::setStickyConfig(const std::shared_ptr<ArrayBuffer>& indices,
                                            double stickyOffset, double stickySize) {
  int32_t count = 0;
  const int32_t* raw = intsOf(indices, count);
  std::lock_guard<std::mutex> guard(state_->stateMutex);
  state_->stickyIndices.clear();
  if (raw != nullptr && count > 0) {
    state_->stickyIndices.assign(raw, raw + count);
    std::sort(state_->stickyIndices.begin(), state_->stickyIndices.end());
    state_->stickyIndices.erase(
        std::unique(state_->stickyIndices.begin(), state_->stickyIndices.end()),
        state_->stickyIndices.end());
  }
  if (std::isfinite(stickyOffset)) state_->stickyOffsetDp = stickyOffset;
  if (std::isfinite(stickySize)) state_->stickySizeDp = std::max(0.0, stickySize);
}

void HybridNitroListEngine::setMvcpConfig(bool enabled, double anchorIndex) {
  std::lock_guard<std::mutex> guard(state_->stateMutex);
  state_->mvcpEnabled = enabled;
  if (!enabled) {
    state_->mvcpDataEnabled = false;
    state_->mvcpAnchorIndex = -1;
    state_->pendingExternalMvcpShiftDp = 0.0;
    return;
  }
  const int32_t idx = std::isfinite(anchorIndex) ? toIndex(anchorIndex) : -1;
  // Convention: anchorIndex == -2 means size-only MVCP (data remap auto-shift disabled).
  state_->mvcpDataEnabled = (idx != -2);
  if (idx >= 0 && idx < state_->itemCount) {
    state_->mvcpAnchorIndex = idx;
    state_->mvcpAnchorOffsetDp = state_->core.getOffset(idx);
  } else {
    state_->captureMvcpAnchorLocked(state_->scrollOffset);
  }
}

double HybridNitroListEngine::reconcileSlots(const std::shared_ptr<ArrayBuffer>& extraIndices,
                                             double budgetSlots,
                                             const std::shared_ptr<ArrayBuffer>& outDeltas) {
  constexpr int32_t kHeaderInts = 8;
  int32_t outCap = 0;
  auto* out = const_cast<int32_t*>(intsOf(outDeltas, outCap));
  if (out == nullptr || outCap < kHeaderInts) return -1;

  int32_t extraCount = 0;
  const int32_t* extra = intsOf(extraIndices, extraCount);
  const int32_t budget = std::isfinite(budgetSlots) ? std::max(0, toIndex(budgetSlots)) : 0;

  std::lock_guard<std::mutex> guard(state_->stateMutex);
  const double vp = state_->mainViewportLocked();
  const auto range = state_->core.getEngagedRange(state_->scrollOffset, vp, state_->drawDistance);
  int32_t focusIndex = range.start;
  // When mounting at the top of the list (scrollOffset <= 0), prioritize from range.start
  // (items 0, 1, 2...) so budgeted first-paint renders top-of-viewport rows first.
  if (range.end >= range.start && vp > 0.0 && state_->scrollOffset > 0.0) {
    const auto center = state_->core.getEngagedRange(state_->scrollOffset + vp * 0.5, 1.0, 0.0);
    if (center.start >= 0 && center.start < state_->itemCount) {
      focusIndex = center.start;
    }
  }

  auto& deltas = state_->scratchDeltas;
  const int32_t deltaCount = state_->slotPool.reconcile(
      state_->itemCount, range.start, range.end, extra, extraCount,
      [this](int32_t i) { return state_->itemTypeAtLocked(i); },
      budget, focusIndex, deltas);

  state_->jsPrewarmActive = (extraCount > 0);
  const StickyState sticky = state_->computeStickyLocked(state_->scrollOffset);
  if (!state_->slotPool.hasMorePending() && budget == 0) {
    state_->committedStart = range.start;
    state_->committedEnd = range.end;
    state_->lastStart = range.start;
    state_->lastEnd = range.end;
    state_->lastVersion = range.version;
    state_->lastStickyIndex = sticky.index;
  } else {
    state_->committedStart = -1;
    state_->committedEnd = -2;
  }
  const int32_t required = kHeaderInts + deltaCount * 4;
  out[0] = deltaCount;
  out[1] = state_->slotPool.slotCount();
  out[2] = range.start;
  out[3] = range.end;
  out[4] = range.version;
  out[5] = sticky.index;
  out[6] = state_->slotPool.hasMorePending() ? 1 : 0;
  out[7] = required;
  if (outCap < required) {
    return -1;
  }
  int32_t* cursor = out + kHeaderInts;
  for (int32_t k = 0; k < deltaCount; ++k) {
    const auto& d = deltas[static_cast<size_t>(k)];
    *cursor++ = d.slotId;
    *cursor++ = d.itemIndex;
    *cursor++ = static_cast<int32_t>(d.generation);
    *cursor++ = static_cast<int32_t>(d.flags);
  }
  return static_cast<double>(deltaCount);
}

void HybridNitroListEngine::dispose() {
  if (engineId_ > 0) {
    EngineRegistry::instance().unregisterState(engineId_);
    engineId_ = 0;
  }
  std::optional<RangeCallback> released;
  {
    std::lock_guard<std::mutex> guard(state_->stateMutex);
    released.swap(onRangeChange_);
    std::vector<double>().swap(pendingSnapshot_);
    state_->disposed = true;
    state_->itemCount = 0;
    state_->lastStart = -1;
    state_->lastEnd = -2;
    state_->lastVersion = -1;
    state_->lastStickyIndex = -1;
    state_->committedStart = -1;
    state_->committedEnd = -2;
    std::vector<uint16_t>().swap(state_->itemTypes);
    std::vector<int32_t>().swap(state_->stickyIndices);
    std::vector<double>().swap(state_->scratchSizePairs);
    std::vector<SlotDelta>().swap(state_->scratchDeltas);
    state_->slotPool.clearAll();
    ++sequence_;
    state_->core.resetAll();
  }
}

size_t HybridNitroListEngine::getExternalMemorySize() noexcept {
  try {
    std::lock_guard<std::mutex> guard(state_->stateMutex);
    return state_->core.getMemoryFootprint() +
           state_->getExtraMemoryFootprintLocked() +
           pendingSnapshot_.capacity() * sizeof(double);
  } catch (...) {
    return 0;
  }
}

} // namespace margelo::nitro::nitrolist
