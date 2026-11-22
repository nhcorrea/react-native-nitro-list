#pragma once

#include "LayoutCore.hpp"
#include "SlotPool.hpp"

#include <algorithm>
#include <atomic>
#include <cmath>
#include <cstdint>
#include <memory>
#include <mutex>
#include <unordered_map>
#include <vector>

namespace margelo::nitro::nitrolist {

struct NativeScrollResult {
  int32_t deltaCount = 0;
  int32_t slotCount = 0;
  int32_t rangeStart = 0;
  int32_t rangeEnd = -1;
  int32_t layoutVersion = 0;
  double totalSizeDp = 0.0;
  int32_t stickyIndex = -1;
  double stickyTranslateYDp = 0.0;
  bool hasMorePending = false;
  bool changed = false;
};

struct NativeSizeResult {
  bool changed = false;
  double mvcpDeltaDp = 0.0;
  double totalSizeDp = 0.0;
  int32_t layoutVersion = 0;
  int32_t stickyIndex = -1;
  double stickyTranslateYDp = 0.0;
};

struct StickyState {
  int32_t index = -1;
  double translateDp = 0.0;
};

struct EngineCoreState {
  std::mutex stateMutex;
  LayoutCore core;
  SlotPool slotPool;

  bool disposed = false;
  int32_t itemCount = 0;
  int32_t numColumns = 1;
  double dataRevision = 0.0;
  double scrollOffset = 0.0;
  double viewportWidth = 0.0;
  double viewportHeight = 0.0;
  double drawDistance = 0.0;
  bool horizontal = false;
  double mainAxisGap = 0.0;
  double paddingStart = 0.0;
  int32_t lastStart = -1;
  int32_t lastEnd = -2;
  int32_t lastVersion = -1;
  int32_t lastStickyIndex = -1;
  int32_t committedStart = -1;
  int32_t committedEnd = -2;

  // Type array mirror for fast O(1) type lookup inside SlotPool without extra LayoutCore locking.
  std::vector<uint16_t> itemTypes;

  // Sticky header configuration (sorted indices)
  std::vector<int32_t> stickyIndices;
  double stickyOffsetDp = 0.0;
  double stickySizeDp = 0.0;

  // Native MVCP anchor tracking
  bool mvcpEnabled = false;
  bool mvcpDataEnabled = true;
  int32_t mvcpAnchorIndex = -1;
  double mvcpAnchorOffsetDp = 0.0;
  // Atomically queued MVCP shift (computed under stateMutex during updateData/setEstimatesFrozen)
  // so UI thread's readSlotTransforms ALWAYS sees post-shift offsets paired with the exact shift!
  double pendingExternalMvcpShiftDp = 0.0;
  // Set while JS scrollToIndex is prewarming slots at an offscreen target offset so syncNow()
  // runs PreDraw measurement/positioning without clobbering scrollOffset with the old sv.scrollY.
  bool jsPrewarmActive = false;

  // Reusable scratch buffers for zero-allocation UI-thread ticks
  std::vector<double> scratchSizePairs;
  std::vector<SlotDelta> scratchDeltas;

  double mainViewportLocked() const { return horizontal ? viewportWidth : viewportHeight; }

  uint16_t itemTypeAtLocked(int32_t index) const {
    if (index < 0 || index >= static_cast<int32_t>(itemTypes.size())) return 0;
    return itemTypes[static_cast<size_t>(index)];
  }

  StickyState computeStickyLocked(double engineOffsetDp) {
    if (stickyIndices.empty() || itemCount <= 0) {
      return StickyState{-1, stickyOffsetDp};
    }
    const double trigger = engineOffsetDp + stickyOffsetDp;
    // Find rightmost sticky index whose offset <= trigger.
    int32_t lo = 0;
    int32_t hi = static_cast<int32_t>(stickyIndices.size());
    while (lo < hi) {
      const int32_t mid = lo + (hi - lo) / 2;
      const int32_t idx = stickyIndices[static_cast<size_t>(mid)];
      const double off = (idx >= 0 && idx < itemCount) ? core.getOffset(idx) : 1e30;
      if (off <= trigger) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    const int32_t pos = lo - 1;
    if (pos < 0) {
      return StickyState{-1, stickyOffsetDp};
    }
    const int32_t activeIdx = stickyIndices[static_cast<size_t>(pos)];
    double translate = stickyOffsetDp;
    if (pos + 1 < static_cast<int32_t>(stickyIndices.size())) {
      const int32_t nextIdx = stickyIndices[static_cast<size_t>(pos + 1)];
      if (nextIdx >= 0 && nextIdx < itemCount) {
        const double nextOff = core.getOffset(nextIdx);
        const double headerH = stickySizeDp > 0.0 ? stickySizeDp : core.getSize(activeIdx);
        const double pushTop = nextOff - engineOffsetDp - headerH;
        if (pushTop < stickyOffsetDp) {
          translate = pushTop;
        }
      }
    }
    return StickyState{activeIdx, translate};
  }

  void captureMvcpAnchorLocked(double engineOffsetDp) {
    if (!mvcpEnabled || itemCount <= 0) {
      mvcpAnchorIndex = -1;
      return;
    }
    const double clamped = std::max(0.0, engineOffsetDp);
    const auto range = core.getEngagedRange(clamped, std::max(1.0, mainViewportLocked()), 0.0);
    if (range.start >= 0 && range.start < itemCount) {
      mvcpAnchorIndex = range.start;
      mvcpAnchorOffsetDp = core.getOffset(range.start);
    }
  }

  NativeScrollResult onNativeScroll(double absoluteOffsetDp,
                                    double velocityDpS,
                                    int32_t budgetSlots,
                                    bool captureAnchor,
                                    std::vector<SlotDelta>& outDeltas,
                                    double jsLatencyMs = 0.0) {
    std::lock_guard<std::mutex> guard(stateMutex);
    outDeltas.clear();
    NativeScrollResult res;
    if (disposed) return res;
    jsPrewarmActive = false;

    // Include any not-yet-drained atomic MVCP shift so C++ engaged range tracks the EXACT
    // visual viewport even if handleScrollChange runs before the next nativeReadTransforms!
    const double engineOffset = absoluteOffsetDp + pendingExternalMvcpShiftDp - paddingStart;
    if (std::isfinite(engineOffset)) {
      scrollOffset = engineOffset;
    }
    const double vp = mainViewportLocked();
    const double total = core.getTotalSize();

    // Hysteresis window ("lazy refill"): skip slotPool.reconcile & Fabric commits while
    // the currently committed range still covers the visible viewport plus a velocity- and
    // JS-latency-scaled safety margin. When JS is fast (<=22ms), cuts Fabric commits 2-3x;
    // when JS is stalled (e.g. busy100), dynamically widens lookahead & refill runway!
    bool reusedCommitted = false;
    int32_t rangeStart = 0;
    int32_t rangeEnd = -1;
    int32_t layoutVersion = core.getLayoutVersion();
    int32_t deltaCount = 0;

    const bool nativeSync = std::isfinite(jsLatencyMs) && jsLatencyMs < 0.0;
    const bool jsSlow = !nativeSync && std::isfinite(jsLatencyMs) && jsLatencyMs > 22.0;
    const double slowRefillScale = jsLatencyMs > 40.0 ? 1.85 : 1.55;

    if (itemCount > 0 && vp > 0.0 && drawDistance > 0.0 && numColumns <= 1 &&
        committedEnd >= committedStart && committedStart >= 0 && committedEnd < itemCount &&
        !slotPool.hasMorePending() && budgetSlots == 0) {
      const double visTop = std::max(0.0, scrollOffset);
      const double visBottom = scrollOffset + vp;
      double triggerMargin;
      if (nativeSync) {
        triggerMargin = drawDistance * 0.25;
      } else if (jsSlow) {
        const double leadSec = std::min(0.160, (jsLatencyMs + 28.0) / 1000.0);
        const double maxMargin = drawDistance * slowRefillScale * 0.92;
        triggerMargin = std::min(maxMargin, std::max(drawDistance * 0.85, std::abs(velocityDpS) * leadSec));
      } else {
        const double frameStep = std::min(drawDistance * 0.90, std::abs(velocityDpS) * 0.028);
        triggerMargin = std::min(drawDistance * 0.92, std::max(drawDistance * 0.40, frameStep));
      }
      const double covTop = core.getOffset(committedStart);
      const double covBottom = core.getOffset(committedEnd) + core.getSize(committedEnd);
      const bool topCovered = committedStart == 0 || covTop <= visTop - triggerMargin;
      const bool botCovered = committedEnd == itemCount - 1 || covBottom >= visBottom + triggerMargin;
      if (topCovered && botCovered) {
        reusedCommitted = true;
        rangeStart = committedStart;
        rangeEnd = committedEnd;
      }
    }

    if (!reusedCommitted) {
      const double refillScale = jsSlow ? slowRefillScale : 1.40;
      const double refillDraw =
          (!nativeSync && numColumns <= 1 && (jsSlow || std::abs(velocityDpS) > 200.0))
              ? drawDistance * refillScale
              : drawDistance;
      const auto range = core.getEngagedRange(scrollOffset, vp, refillDraw);
      rangeStart = range.start;
      rangeEnd = range.end;
      layoutVersion = range.version;

      // Compute focus item index (center of viewport) for budget prioritization.
      int32_t focusIndex = rangeStart;
      if (rangeEnd >= rangeStart && vp > 0.0) {
        const auto centerRange = core.getEngagedRange(scrollOffset + vp * 0.5, 1.0, 0.0);
        if (centerRange.start >= 0 && centerRange.start < itemCount) {
          focusIndex = centerRange.start;
        }
      }

      deltaCount = slotPool.reconcile(
          itemCount, rangeStart, rangeEnd, nullptr, 0,
          [this](int32_t i) { return itemTypeAtLocked(i); },
          budgetSlots, focusIndex, outDeltas);

      if (!slotPool.hasMorePending() && budgetSlots == 0) {
        committedStart = rangeStart;
        committedEnd = rangeEnd;
      } else {
        committedStart = -1;
        committedEnd = -2;
      }
    }

    const StickyState sticky = computeStickyLocked(scrollOffset);
    if (captureAnchor && mvcpEnabled) {
      captureMvcpAnchorLocked(scrollOffset);
    }

    const bool changed = deltaCount > 0 || rangeStart != lastStart || rangeEnd != lastEnd ||
                         (!reusedCommitted && layoutVersion != lastVersion) ||
                         sticky.index != lastStickyIndex;
    lastStart = rangeStart;
    lastEnd = rangeEnd;
    if (!reusedCommitted) {
      lastVersion = layoutVersion;
    }
    lastStickyIndex = sticky.index;

    res.deltaCount = deltaCount;
    res.slotCount = slotPool.slotCount();
    res.rangeStart = rangeStart;
    res.rangeEnd = rangeEnd;
    res.layoutVersion = layoutVersion;
    res.totalSizeDp = total;
    res.stickyIndex = sticky.index;
    res.stickyTranslateYDp = sticky.translateDp;
    res.hasMorePending = slotPool.hasMorePending();
    res.changed = changed;
    return res;
  }

  NativeSizeResult onNativeSlotSizes(const int32_t* slotIds,
                                     const double* sizesDp,
                                     const uint32_t* seenGenerations,
                                     int32_t count,
                                     bool applyMvcp) {
    std::lock_guard<std::mutex> guard(stateMutex);
    NativeSizeResult res;
    if (disposed || slotIds == nullptr || sizesDp == nullptr || count <= 0) {
      return res;
    }

    scratchSizePairs.clear();
    auto& slots = slotPool.slotsMut();
    const int32_t totalSlots = static_cast<int32_t>(slots.size());
    for (int32_t k = 0; k < count; ++k) {
      const int32_t slotId = slotIds[k];
      const double rawSize = sizesDp[k];
      if (slotId < 0 || slotId >= totalSlots || !std::isfinite(rawSize) || rawSize < 0.0) continue;
      auto& slot = slots[static_cast<size_t>(slotId)];
      if (seenGenerations != nullptr && seenGenerations[k] > 0) {
        slot.committedGen = seenGenerations[k];
      }
      if (!slot.active || !slot.measures || slot.itemIndex < 0 || slot.itemIndex >= itemCount) {
        continue;
      }
      // Critical race guard: never attribute stale pre-rebind height to a newly bound item.
      if (slot.committedGen != slot.generation) {
        continue;
      }
      const double measured = rawSize + mainAxisGap;
      if (slot.measuredSize >= 0.0 && std::abs(slot.measuredSize - measured) <= 0.125) {
        continue;
      }
      slot.measuredSize = measured;
      scratchSizePairs.push_back(static_cast<double>(slot.itemIndex));
      scratchSizePairs.push_back(measured);
    }

    const int32_t pairCount = static_cast<int32_t>(scratchSizePairs.size() / 2);
    if (pairCount > 0) {
      if (applyMvcp && mvcpEnabled && !jsPrewarmActive && mvcpAnchorIndex >= 0 &&
          mvcpAnchorIndex < itemCount) {
        res.mvcpDeltaDp =
            core.setItemSizesAnchored(scratchSizePairs.data(), pairCount, 1.0, mvcpAnchorIndex);
        mvcpAnchorOffsetDp += res.mvcpDeltaDp;
        res.changed = true;
      } else {
        res.changed = core.setItemSizes(scratchSizePairs.data(), pairCount, 1.0);
      }
    }

    res.totalSizeDp = core.getTotalSize();
    res.layoutVersion = core.getLayoutVersion();
    const StickyState sticky = computeStickyLocked(scrollOffset);
    res.stickyIndex = sticky.index;
    res.stickyTranslateYDp = sticky.translateDp;
    return res;
  }

  // Writes per-slot transforms for PreDraw:
  // outOffsetsDp[s] = item offset in dp
  // outMeta[s * 3 + 0] = active (1) / inactive (0)
  // outMeta[s * 3 + 1] = expected generation
  // outMeta[s * 3 + 2] = measures (1) / fixed (0)
  int32_t readSlotTransforms(double* outOffsetsDp,
                             int32_t* outMeta,
                             int32_t maxSlots,
                             double& outTotalSizeDp,
                             int32_t& outStickyIndex,
                             double& outStickyTranslateYDp,
                             double* outPendingMvcpShiftDp = nullptr) {
    std::lock_guard<std::mutex> guard(stateMutex);
    if (disposed) {
      outTotalSizeDp = 0.0;
      outStickyIndex = -1;
      outStickyTranslateYDp = 0.0;
      if (outPendingMvcpShiftDp != nullptr) *outPendingMvcpShiftDp = 0.0;
      return 0;
    }
    const auto& slots = slotPool.slots();
    const int32_t count = std::min(maxSlots, static_cast<int32_t>(slots.size()));
    for (int32_t s = 0; s < count; ++s) {
      const auto& slot = slots[static_cast<size_t>(s)];
      const bool validActive = slot.active && slot.itemIndex >= 0 && slot.itemIndex < itemCount;
      outOffsetsDp[s] = validActive ? core.getOffset(slot.itemIndex) : 0.0;
      outMeta[s * 3 + 0] = validActive ? 1 : 0;
      outMeta[s * 3 + 1] = static_cast<int32_t>(slot.generation);
      outMeta[s * 3 + 2] = slot.measures ? 1 : 0;
    }
    outTotalSizeDp = core.getTotalSize();
    const StickyState sticky = computeStickyLocked(scrollOffset);
    outStickyIndex = sticky.index;
    outStickyTranslateYDp = sticky.translateDp;
    if (outPendingMvcpShiftDp != nullptr) {
      *outPendingMvcpShiftDp = pendingExternalMvcpShiftDp;
      pendingExternalMvcpShiftDp = 0.0;
    }
    return count;
  }

  // Level 3: Writes per-slot transforms + item/grid metadata for pure-native template rendering:
  // outOffsetsDp[s] = item offset in dp
  // outInfo[s * 6 + 0] = active (1) / inactive (0)
  // outInfo[s * 6 + 1] = itemIndex
  // outInfo[s * 6 + 2] = generation
  // outInfo[s * 6 + 3] = col (0..numColumns-1)
  // outInfo[s * 6 + 4] = span (1..numColumns)
  // outInfo[s * 6 + 5] = measures (1) / fixed (0)
  int32_t readTemplateSlots(double* outOffsetsDp,
                            int32_t* outInfo,
                            int32_t maxSlots,
                            double& outTotalSizeDp,
                            int32_t& outStickyIndex,
                            double& outStickyTranslateYDp,
                            double* outPendingMvcpShiftDp = nullptr) {
    std::lock_guard<std::mutex> guard(stateMutex);
    if (disposed) {
      outTotalSizeDp = 0.0;
      outStickyIndex = -1;
      outStickyTranslateYDp = 0.0;
      if (outPendingMvcpShiftDp != nullptr) *outPendingMvcpShiftDp = 0.0;
      return 0;
    }
    const auto& slots = slotPool.slots();
    const int32_t count = std::min(maxSlots, static_cast<int32_t>(slots.size()));
    for (int32_t s = 0; s < count; ++s) {
      const auto& slot = slots[static_cast<size_t>(s)];
      const bool validActive = slot.active && slot.itemIndex >= 0 && slot.itemIndex < itemCount;
      outOffsetsDp[s] = validActive ? core.getOffset(slot.itemIndex) : 0.0;
      int32_t col = 0;
      int32_t span = 1;
      if (validActive && numColumns > 1) {
        core.getColumnSpan(slot.itemIndex, col, span);
      }
      outInfo[s * 6 + 0] = validActive ? 1 : 0;
      outInfo[s * 6 + 1] = validActive ? slot.itemIndex : -1;
      outInfo[s * 6 + 2] = static_cast<int32_t>(slot.generation);
      outInfo[s * 6 + 3] = col;
      outInfo[s * 6 + 4] = span;
      outInfo[s * 6 + 5] = slot.measures ? 1 : 0;
    }
    outTotalSizeDp = core.getTotalSize();
    const StickyState sticky = computeStickyLocked(scrollOffset);
    outStickyIndex = sticky.index;
    outStickyTranslateYDp = sticky.translateDp;
    if (outPendingMvcpShiftDp != nullptr) {
      *outPendingMvcpShiftDp = pendingExternalMvcpShiftDp;
      pendingExternalMvcpShiftDp = 0.0;
    }
    return count;
  }

  void markSlotCommitted(int32_t slotId, uint32_t generation) {
    std::lock_guard<std::mutex> guard(stateMutex);
    if (!disposed) {
      slotPool.markSlotCommitted(slotId, generation);
    }
  }

  void setSlotViewTag(int32_t slotId, int32_t viewTag, bool measures) {
    std::lock_guard<std::mutex> guard(stateMutex);
    if (!disposed) {
      slotPool.setSlotViewTag(slotId, viewTag, measures);
    }
  }

  void unregisterSlotView(int32_t slotId) {
    std::lock_guard<std::mutex> guard(stateMutex);
    if (!disposed) {
      slotPool.unregisterSlotView(slotId);
    }
  }

  void setSlotMeasures(int32_t slotId, bool measures) {
    std::lock_guard<std::mutex> guard(stateMutex);
    if (!disposed) {
      slotPool.setSlotMeasures(slotId, measures);
    }
  }

  bool isJsPrewarmActive() {
    std::lock_guard<std::mutex> guard(stateMutex);
    return !disposed && jsPrewarmActive;
  }

  void setMvcpEnabled(bool enabled) {
    std::lock_guard<std::mutex> guard(stateMutex);
    mvcpEnabled = enabled;
    if (enabled) {
      captureMvcpAnchorLocked(scrollOffset);
    } else {
      mvcpAnchorIndex = -1;
    }
  }

  void updateHostGeometry(double nextPaddingStart, double nextMainAxisGap) {
    std::lock_guard<std::mutex> guard(stateMutex);
    if (std::isfinite(nextPaddingStart)) paddingStart = nextPaddingStart;
    if (std::isfinite(nextMainAxisGap)) mainAxisGap = std::max(0.0, nextMainAxisGap);
  }

  void onNativeMomentumEnd(double absoluteOffsetDp) {
    std::lock_guard<std::mutex> guard(stateMutex);
    if (disposed) return;
    // Include any not-yet-drained atomic MVCP shift so C++ engaged range tracks the EXACT
    // visual viewport even if handleScrollChange runs before the next nativeReadTransforms!
    const double engineOffset = absoluteOffsetDp + pendingExternalMvcpShiftDp - paddingStart;
    if (std::isfinite(engineOffset)) {
      scrollOffset = engineOffset;
      core.resetScrollVelocity();
      if (mvcpEnabled) {
        captureMvcpAnchorLocked(scrollOffset);
      }
    }
  }

  size_t getExtraMemoryFootprintLocked() const {
    return slotPool.getMemoryFootprint() +
           itemTypes.capacity() * sizeof(uint16_t) +
           stickyIndices.capacity() * sizeof(int32_t) +
           scratchSizePairs.capacity() * sizeof(double) +
           scratchDeltas.capacity() * sizeof(SlotDelta);
  }
};

class EngineRegistry {
public:
  static EngineRegistry& instance() {
    static EngineRegistry registry;
    return registry;
  }

  int64_t registerState(const std::shared_ptr<EngineCoreState>& state) {
    const int64_t id = nextId_.fetch_add(1, std::memory_order_relaxed);
    std::lock_guard<std::mutex> guard(mutex_);
    entries_[id] = state;
    return id;
  }

  void unregisterState(int64_t id) {
    if (id <= 0) return;
    std::lock_guard<std::mutex> guard(mutex_);
    entries_.erase(id);
  }

  std::shared_ptr<EngineCoreState> find(int64_t id) {
    if (id <= 0) return nullptr;
    std::lock_guard<std::mutex> guard(mutex_);
    const auto it = entries_.find(id);
    if (it == entries_.end()) return nullptr;
    auto locked = it->second.lock();
    if (!locked) {
      entries_.erase(it);
    }
    return locked;
  }

private:
  std::atomic<int64_t> nextId_{1};
  std::mutex mutex_;
  std::unordered_map<int64_t, std::weak_ptr<EngineCoreState>> entries_;
};

} // namespace margelo::nitro::nitrolist
